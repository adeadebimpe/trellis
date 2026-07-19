import type { ProjectInference } from './types';

// Pure helpers for the repo scan: README parsing and the human-readable
// summaries seeded into project context. Keep this module free of vscode
// imports so tests can bundle it directly (see tests/inference.test.mjs).

export interface ReadmeSummary {
  title?: string;
  summary?: string;
}

const READ_ME_SUMMARY_LIMIT = 300;

export function parseReadme(text: string): ReadmeSummary {
  const result: ReadmeSummary = {};
  const lines = text.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!result.title) {
      const heading = line.match(/^#\s+(.*)$/);
      if (heading) {
        result.title = heading[1].trim();
        continue;
      }
    }
    const isBadge = line.startsWith('![') || line.startsWith('[![');
    const isMarkup = line.startsWith('#') || line.startsWith('>') || line.startsWith('<') || line.startsWith('---') || line.startsWith('```');
    if (!line || isBadge || isMarkup) {
      if (paragraph.length) {
        break;
      }
      continue;
    }
    paragraph.push(line);
  }
  if (paragraph.length) {
    const joined = paragraph.join(' ');
    result.summary = joined.length > READ_ME_SUMMARY_LIMIT ? `${joined.slice(0, READ_ME_SUMMARY_LIMIT - 1).trimEnd()}…` : joined;
  }
  return result;
}

export function inferredContextNotes(inference: ProjectInference): string {
  const lines: string[] = [];
  const headline = inference.projectDescription || inference.readmeTitle;
  if (inference.projectName && headline && headline !== inference.projectName) {
    lines.push(`${inference.projectName} — ${headline}`);
  } else if (inference.projectName) {
    lines.push(inference.projectName);
  } else if (headline) {
    lines.push(headline);
  }
  if (inference.readmeSummary && inference.readmeSummary !== headline) {
    lines.push(inference.readmeSummary);
  }
  if (inference.likelyStack.length) {
    lines.push(`Stack: ${inference.likelyStack.join(', ')}`);
  }
  if (inference.topLevelDirs?.length) {
    lines.push(`Layout: ${inference.topLevelDirs.map((dir) => `${dir}/`).join(', ')}`);
  }
  const tooling: string[] = [];
  if (inference.packageManager) {
    tooling.push(`Package manager: ${inference.packageManager}`);
  }
  if (inference.scripts.length) {
    tooling.push(`Scripts: ${inference.scripts.join(', ')}`);
  }
  if (tooling.length) {
    lines.push(tooling.join(' · '));
  }
  if (inference.suggestedValidation.length) {
    lines.push(`Validation: ${inference.suggestedValidation.join(', ')}`);
  }
  return lines.join('\n');
}

export function inferredArchitectureNotes(inference: ProjectInference): string {
  const lines: string[] = [];
  if (inference.likelyStack.length) {
    lines.push(`Detected stack: ${inference.likelyStack.join(', ')}.`);
  }
  if (inference.packageManager) {
    lines.push(`Package manager: ${inference.packageManager}.`);
  }
  if (inference.detectedFiles.length) {
    lines.push(`Key files: ${inference.detectedFiles.join(', ')}.`);
  }
  return lines.join('\n');
}

// Legacy format from before the scan produced a description — kept so boards
// seeded with the old text still count as "untouched" and refresh on re-run.
export function legacyContextNotes(inference: ProjectInference): string {
  const lines: string[] = [];
  if (inference.likelyStack.length) {
    lines.push(`Stack: ${inference.likelyStack.join(', ')}`);
  }
  if (inference.packageManager) {
    lines.push(`Package manager: ${inference.packageManager}`);
  }
  if (inference.scripts.length) {
    lines.push(`Scripts: ${inference.scripts.join(', ')}`);
  }
  if (inference.detectedFiles.length) {
    lines.push(`Key files: ${inference.detectedFiles.join(', ')}`);
  }
  if (inference.suggestedValidation.length) {
    lines.push(`Validation: ${inference.suggestedValidation.join(', ')}`);
  }
  return lines.join('\n');
}

export function shouldReplaceNotes(existingNotes: string, previousInference: ProjectInference | undefined): boolean {
  const current = (existingNotes ?? '').trim();
  if (!current) {
    return true;
  }
  if (!previousInference) {
    return false;
  }
  const generated = (previousInference.generatedNotes ?? '').trim();
  if (generated && current === generated) {
    return true;
  }
  return current === legacyContextNotes(previousInference).trim() || current === inferredContextNotes(previousInference).trim();
}

export function shouldReplaceValidation(existing: string[], previousInference: ProjectInference | undefined): boolean {
  if (!existing.length) {
    return true;
  }
  if (!previousInference) {
    return false;
  }
  const generated = previousInference.generatedValidation ?? previousInference.suggestedValidation ?? [];
  return existing.length === generated.length && existing.every((command, index) => command === generated[index]);
}

export function shouldReplaceArchitecture(existingNotes: string, previousInference: ProjectInference | undefined): boolean {
  const current = (existingNotes ?? '').trim();
  if (!current) {
    return true;
  }
  if (!previousInference) {
    return false;
  }
  return current === inferredArchitectureNotes(previousInference).trim();
}
