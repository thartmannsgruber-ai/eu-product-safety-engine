/**
 * apps/mcp/src/sanitizer.ts
 *
 * Strikte Eingabebereinigung und Schutz vor Prompt-Injection fuer MCP Tools.
 * - Entfernt Steuerzeichen (ASCII Control Chars, Nullbytes, BiDi Overrides, Zero-Width Chars).
 * - Begrenzt die Laenge auf definierte Maxima.
 * - Erkennt und neutralisiert Prompt-Injection-Muster.
 */

import { z } from 'zod';

export const DEFAULT_MAX_LENGTH = 2048;
export const NEUTRALIZED_TAG = '[NEUTRALIZED_PROMPT_INJECTION]';

/**
 * Regex fuer unerwuenschte Steuerzeichen:
 * - ASCII 0-8, 11-12, 14-31, 127 (Tab \x09, LF \x0A, CR \x0D bleiben erhalten)
 * - Zero-width spaces / joiners (\u200B-\u200D, \uFEFF)
 * - Bidirektionale Override-Zeichen (\u200E, \u200F, \u202A-\u202E, \u2066-\u2069)
 */
export const CONTROL_CHARS_REGEX =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Bekannte Prompt-Injection- und Jailbreak-Muster
 */
export const PROMPT_INJECTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'instruction_override',
    regex:
      /(?:ignore|disregard|forget|bypass|override)\s+(?:all\s+)?(?:previous|prior|above|existing|system)\s+(?:instructions|prompts|rules|commands|constraints|directives)/gi,
  },
  {
    name: 'role_impersonation',
    regex:
      /(?:you are now|you must now act as|act as|pretend to be)\s+(?:an?\s+)?(?:unrestricted|jailbroken|evil|dan|developer mode|root|admin)\b/gi,
  },
  {
    name: 'secret_leakage',
    regex:
      /(?:reveal|show|print|leak|output|dump)\s+(?:all\s+)?(?:secret|hidden|internal|system)\s+(?:prompts?|instructions?|keys?|tokens?|rules?)/gi,
  },
  {
    name: 'system_delimiters',
    regex:
      /(?:<<SYS>>|<\/SYS>|<system>|<\/system>|\[SYSTEM\]|\[\/SYSTEM\]|\[INST\]|\[\/INST\]|system\s*prompt\s*:)/gi,
  },
  {
    name: 'fenced_code_injection',
    regex: /```(?:system|instruction|prompt)\b/gi,
  },
  {
    name: 'line_role_prefix',
    regex: /^(?:system|assistant|human|user)\s*:/gim,
  },
  {
    name: 'jailbreak_keywords',
    regex: /\b(?:dan\s*mode|jailbreak\s*mode|do\s*anything\s*now)\b/gi,
  },
];

export interface SanitizeOptions {
  maxLength?: number;
  truncate?: boolean;
  stripControlChars?: boolean;
  neutralizeInjection?: boolean;
  throwOnInjection?: boolean;
  replacementTag?: string;
  trim?: boolean;
}

export class PromptInjectionError extends Error {
  public readonly detectedPatterns: string[];

  constructor(message: string, detectedPatterns: string[] = []) {
    super(message);
    this.name = 'PromptInjectionError';
    this.detectedPatterns = detectedPatterns;
  }
}

/**
 * Entfernt schaedliche Steuerzeichen aus dem Eingabestring.
 */
export function stripControlCharacters(input: string): string {
  if (typeof input !== 'string') return '';
  return input.replace(CONTROL_CHARS_REGEX, '');
}

/**
 * Prueft, ob ein Eingabestring verdaechtige Prompt-Injection-Muster enthaelt.
 */
export function detectPromptInjection(input: string): { isInjected: boolean; patterns: string[] } {
  if (typeof input !== 'string' || input.length === 0) {
    return { isInjected: false, patterns: [] };
  }

  const detected: string[] = [];

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    // Reset RegExp lastIndex if global
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(input)) {
      detected.push(pattern.name);
    }
  }

  return {
    isInjected: detected.length > 0,
    patterns: detected,
  };
}

/**
 * Neutralisiert Prompt-Injection-Muster im String durch Ersetzen mit einem sicheren Tag.
 */
export function neutralizePromptInjection(
  input: string,
  replacement = NEUTRALIZED_TAG,
): { sanitized: string; neutralizedCount: number; matchedPatterns: string[] } {
  if (typeof input !== 'string') {
    return { sanitized: '', neutralizedCount: 0, matchedPatterns: [] };
  }

  let sanitized = input;
  let neutralizedCount = 0;
  const matchedPatterns: string[] = [];

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(sanitized)) {
      matchedPatterns.push(pattern.name);
      pattern.regex.lastIndex = 0;
      sanitized = sanitized.replace(pattern.regex, () => {
        neutralizedCount++;
        return replacement;
      });
    }
  }

  return { sanitized, neutralizedCount, matchedPatterns };
}

/**
 * Bereinigt Eingaben umfassend:
 * 1. Entfernt Steuerzeichen & Null-Bytes
 * 2. Prueft / neutralisiert Prompt-Injections
 * 3. Begrenzt die Laenge
 */
export function sanitizeInput(input: unknown, options: SanitizeOptions = {}): string {
  if (input === null || input === undefined) return '';
  let str = typeof input === 'string' ? input : String(input);

  const {
    maxLength = DEFAULT_MAX_LENGTH,
    truncate = true,
    stripControlChars = true,
    neutralizeInjection = true,
    throwOnInjection = false,
    replacementTag = NEUTRALIZED_TAG,
    trim = true,
  } = options;

  if (stripControlChars) {
    str = stripControlCharacters(str);
  }

  if (trim) {
    str = str.trim();
  }

  if (throwOnInjection) {
    const check = detectPromptInjection(str);
    if (check.isInjected) {
      throw new PromptInjectionError(
        `Prompt injection detected: [${check.patterns.join(', ')}]`,
        check.patterns,
      );
    }
  }

  if (neutralizeInjection) {
    const result = neutralizePromptInjection(str, replacementTag);
    str = result.sanitized;
  }

  if (maxLength > 0 && str.length > maxLength) {
    if (truncate) {
      str = str.slice(0, maxLength);
    } else {
      throw new Error(`Input length (${str.length}) exceeds maximum allowed length (${maxLength})`);
    }
  }

  return str;
}

/**
 * Zod-Schema-Helfer fuer sichere String-Eingaben in MCP Tools.
 */
export function createSafeStringSchema(
  options: {
    minLength?: number;
    maxLength?: number;
    description?: string;
    throwOnInjection?: boolean;
  } = {},
) {
  const { minLength = 0, maxLength = DEFAULT_MAX_LENGTH, description, throwOnInjection = false } = options;

  let schema = z
    .string()
    .min(minLength, `Input must have at least ${minLength} characters`)
    .max(maxLength, `Input must not exceed ${maxLength} characters`)
    .transform((val) =>
      sanitizeInput(val, {
        maxLength,
        throwOnInjection,
      }),
    );

  if (description) {
    return schema.describe(description);
  }

  return schema;
}
