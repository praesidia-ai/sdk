import type { CheckResult, TriggeredGuardrail } from './types.js';

/**
 * Bundled rule-based guardrail patterns for local / offline mode.
 *
 * These run synchronously with zero API calls and cover the most common
 * safety categories. They are intentionally conservative (low false-positive
 * rate) — remote guardrails with ML/LLM tiers are available via a connected
 * Praesidia account.
 */

interface LocalRule {
  id: string;
  name: string;
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  patterns: RegExp[];
  keywords: string[];
}

const LOCAL_RULES: LocalRule[] = [
  {
    id: 'local-prompt-injection',
    name: 'Prompt Injection (local)',
    category: 'prompt_injection',
    severity: 'HIGH',
    patterns: [
      /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
      /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
      /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
      /you\s+are\s+now\s+(a\s+)?(different|new|evil|unfiltered|uncensored)/i,
      /act\s+as\s+(if\s+you\s+(are|were)\s+)?(dan|do anything now|jailbreak)/i,
      /\bDAN\b.*no\s+restrictions/i,
      /system\s*:\s*you\s+are/i,
    ],
    keywords: [],
  },
  {
    id: 'local-pii-ssn',
    name: 'PII — Social Security Number (local)',
    category: 'pii',
    severity: 'HIGH',
    patterns: [/\b\d{3}-\d{2}-\d{4}\b/, /\b\d{9}\b(?=\s*\b(ssn|social)\b)/i],
    keywords: [],
  },
  {
    id: 'local-pii-credit-card',
    name: 'PII — Credit Card Number (local)',
    category: 'pii',
    severity: 'HIGH',
    // Luhn-adjacent: 13-19 digit sequences with optional spaces/dashes
    patterns: [/\b(?:\d[ -]?){13,19}\b/],
    keywords: [],
  },
  {
    id: 'local-hate-speech',
    name: 'Hate Speech (local)',
    category: 'hate_speech',
    severity: 'HIGH',
    patterns: [],
    // Intentionally minimal list — full ML-based detection in connected mode
    keywords: ['kill all', 'exterminate', 'genocide'],
  },
  {
    id: 'local-violence',
    name: 'Violence / Threats (local)',
    category: 'violence',
    severity: 'MEDIUM',
    patterns: [
      /i\s+(will|am going to|gonna)\s+(kill|murder|harm|attack|shoot)\s+(you|him|her|them)/i,
    ],
    keywords: [],
  },
];

/**
 * Run the bundled local rules against content.
 * Returns a CheckResult with local: true.
 */
export function runLocalRules(content: string): CheckResult {
  const triggered: TriggeredGuardrail[] = [];

  for (const rule of LOCAL_RULES) {
    const matchedPatterns: string[] = [];
    const matchedKeywords: string[] = [];

    for (const pattern of rule.patterns) {
      const match = pattern.exec(content);
      if (match) {
        matchedPatterns.push(match[0]);
      }
    }

    const lower = content.toLowerCase();
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
      }
    }

    if (matchedPatterns.length > 0 || matchedKeywords.length > 0) {
      triggered.push({
        guardrailId: rule.id,
        guardrailName: rule.name,
        category: rule.category,
        severity: rule.severity,
        action: 'BLOCK',
        reason: 'Matched local rule-based pattern',
        matchedPatterns,
        matchedKeywords,
      });
    }
  }

  return {
    passed: triggered.length === 0,
    triggered,
    local: true,
  };
}
