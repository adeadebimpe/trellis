import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBoardTask, ProjectContext } from './types';
import { AgentSpecPatch, buildPrdPrompt, normalizeSpecPatch } from './prdPrompt';

const OPENAI_KEY = 'agentBoard.openaiApiKey';
const AI_PROVIDER_KEY = 'agentBoard.aiProvider';
const AI_MODEL_KEY = 'agentBoard.aiModel';
const SPEC_PROVIDER_KEY = 'agentBoard.specProvider';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const CLI_TIMEOUT_MS = 120000;

type SpecProvider = 'openai' | 'codex-cli' | 'claude-code';

interface AiSettings {
  provider: 'openai';
  model: string;
  apiKey: string;
}

export async function configureAi(context: vscode.ExtensionContext): Promise<void> {
  const provider = await vscode.window.showQuickPick(
    [{ label: 'OpenAI', value: 'openai' as const, description: 'Use an OpenAI API key with the Responses API' }],
    { title: 'Agent Board AI Provider' }
  );
  if (!provider) {
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: 'OpenAI API Key',
    prompt: 'Paste your OpenAI API key. It will be stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true
  });
  if (!apiKey) {
    return;
  }

  const model = await vscode.window.showInputBox({
    title: 'OpenAI Model',
    prompt: 'Choose the model Agent Board should use for task specs.',
    value: context.globalState.get<string>(AI_MODEL_KEY, DEFAULT_OPENAI_MODEL),
    ignoreFocusOut: true
  });
  if (!model) {
    return;
  }

  await context.secrets.store(OPENAI_KEY, apiKey.trim());
  await context.globalState.update(AI_PROVIDER_KEY, provider.value);
  await context.globalState.update(AI_MODEL_KEY, model.trim());
  vscode.window.showInformationMessage(`Agent Board AI configured with ${model.trim()}.`);
}

export async function configureSpecProvider(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Codex CLI', value: 'codex-cli' as const, description: 'Use your signed-in Codex CLI with codex exec' },
      { label: 'Claude Code', value: 'claude-code' as const, description: 'Use your signed-in Claude Code CLI with claude -p' },
      { label: 'OpenAI API key', value: 'openai' as const, description: 'Use the Responses API from the extension' }
    ],
    { title: 'Agent Board Spec Generation Provider' }
  );
  if (!choice) {
    return;
  }

  await context.globalState.update(SPEC_PROVIDER_KEY, choice.value);
  await context.globalState.update('agentBoard.onboardingComplete', true);
  if (choice.value === 'openai') {
    await configureAi(context);
    return;
  }

  vscode.window.showInformationMessage(`Agent Board spec provider set to ${choice.label}.`);
}

export function getSpecProvider(context: vscode.ExtensionContext): SpecProvider | undefined {
  return context.globalState.get<SpecProvider>(SPEC_PROVIDER_KEY);
}

export async function setSpecProvider(context: vscode.ExtensionContext, provider: SpecProvider): Promise<void> {
  await context.globalState.update(SPEC_PROVIDER_KEY, provider);
}

export function specProviderLabel(provider: SpecProvider | undefined): string {
  if (provider === 'codex-cli') return 'Codex CLI';
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'openai') return 'OpenAI API';
  return 'Not configured';
}

export async function clearAi(context: vscode.ExtensionContext): Promise<void> {
  await resetAiSettings(context);
  vscode.window.showInformationMessage('Agent Board AI settings cleared.');
}

export async function hasAiSettings(context: vscode.ExtensionContext): Promise<boolean> {
  return Boolean(await context.secrets.get(OPENAI_KEY));
}

export async function resetAiSettings(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(OPENAI_KEY);
  await context.globalState.update(AI_PROVIDER_KEY, undefined);
  await context.globalState.update(AI_MODEL_KEY, undefined);
  await context.globalState.update(SPEC_PROVIDER_KEY, undefined);
  await context.globalState.update('agentBoard.onboardingComplete', undefined);
}

export async function generateAgentSpecWithAi(
  context: vscode.ExtensionContext,
  task: AgentBoardTask,
  project: ProjectContext,
  workspacePath: string
): Promise<AgentSpecPatch | undefined> {
  const provider = await resolveSpecProvider(context);
  if (provider === 'codex-cli') {
    return callCodexCli(task, project, workspacePath);
  }
  if (provider === 'claude-code') {
    return callClaudeCode(task, project, workspacePath);
  }

  const settings = await getAiSettings(context);
  if (!settings) {
    const choice = await vscode.window.showInformationMessage(
      'Configure AI to generate an agent spec?',
      'Configure AI'
    );
    if (choice === 'Configure AI') {
      await configureAi(context);
      const configured = await getAiSettings(context);
      if (!configured) {
        return undefined;
      }
      return callOpenAi(configured, task, project);
    }
    return undefined;
  }

  return callOpenAi(settings, task, project);
}

async function resolveSpecProvider(context: vscode.ExtensionContext): Promise<SpecProvider> {
  const saved = context.globalState.get<SpecProvider>(SPEC_PROVIDER_KEY);
  if (saved) {
    return saved;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Codex CLI', value: 'codex-cli' as const, description: 'Uses your existing Codex CLI sign-in' },
      { label: 'Claude Code', value: 'claude-code' as const, description: 'Uses your existing Claude Code sign-in' },
      { label: 'OpenAI API key', value: 'openai' as const, description: 'Uses direct API access from the extension' }
    ],
    { title: 'Choose how Agent Board should generate specs' }
  );

  if (!choice) {
    throw new Error('Choose Codex, Claude, or OpenAI before generating a PRD.');
  }
  await context.globalState.update(SPEC_PROVIDER_KEY, choice.value);
  return choice.value;
}

async function getAiSettings(context: vscode.ExtensionContext): Promise<AiSettings | undefined> {
  const apiKey = await context.secrets.get(OPENAI_KEY);
  if (!apiKey) {
    return undefined;
  }

  return {
    provider: 'openai',
    model: context.globalState.get<string>(AI_MODEL_KEY, DEFAULT_OPENAI_MODEL),
    apiKey
  };
}

async function callOpenAi(settings: AiSettings, task: AgentBoardTask, project: ProjectContext): Promise<AgentSpecPatch> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.model,
      input: buildPrdPrompt(task, project)
    })
  });

  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = extractErrorMessage(json) ?? `OpenAI request failed with status ${response.status}.`;
    throw new Error(message);
  }

  const text = extractOutputText(json);
  const parsed = parseJsonObject(text);
  return normalizeSpecPatch(parsed, task, project);
}

async function callCodexCli(task: AgentBoardTask, project: ProjectContext, workspacePath: string): Promise<AgentSpecPatch> {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-board-codex-'));
  const outputPath = join(tempDir, 'spec.json');
  try {
    const stdout = await runCli('codex', [
      'exec',
      '--skip-git-repo-check',
      '--output-last-message',
      outputPath,
      buildPrdPrompt(task, project)
    ], {
      cwd: workspacePath,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 5
    });
    const finalText = await readFile(outputPath, 'utf8').catch(() => stdout);
    return normalizeSpecPatch(parseJsonObject(finalText), task, project);
  } catch (error) {
    throw new Error(`Codex CLI spec generation failed or timed out after ${Math.round(CLI_TIMEOUT_MS / 1000)} seconds. Make sure Codex can run non-interactively with codex exec. ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function callClaudeCode(task: AgentBoardTask, project: ProjectContext, workspacePath: string): Promise<AgentSpecPatch> {
  try {
    const stdout = await runCli('claude', ['-p', '--output-format', 'text', buildPrdPrompt(task, project)], {
      cwd: workspacePath,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 5
    });
    return normalizeSpecPatch(parseJsonObject(stdout), task, project);
  } catch (error) {
    throw new Error(`Claude Code spec generation failed or timed out after ${Math.round(CLI_TIMEOUT_MS / 1000)} seconds. Make sure Claude Code can run non-interactively with claude -p. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runCli(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.round(options.timeout / 1000)} seconds. ${stderr.trim()}`.trim()));
    }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > options.maxBuffer) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error(`${command} produced too much output.`));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > options.maxBuffer) {
        stderr = stderr.slice(-options.maxBuffer);
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} exited with code ${code}. ${stderr.trim()}`.trim()));
    });
  });
}

function extractOutputText(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') {
    return json.output_text;
  }

  const output = Array.isArray(json.output) ? json.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          chunks.push(text);
        }
      }
    }
  }

  if (!chunks.length) {
    throw new Error('OpenAI response did not include output text.');
  }
  return chunks.join('\n');
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('AI response was not valid JSON.');
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
}

function extractErrorMessage(json: Record<string, unknown>): string | undefined {
  const error = json.error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
}
