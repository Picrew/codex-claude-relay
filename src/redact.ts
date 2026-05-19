/**
 * Best-effort secret redaction for handoff prompts.
 *
 * This is intentionally conservative: it should never block real content from
 * being passed along, but it must catch the most common leak shapes. Users who
 * need stronger guarantees can pipe `relay preview` through their own scrubber
 * or run with `--no-redact` only when they trust the transcript.
 */

function shortKeep(m: string): string {
  if (m.length <= 8) return '[REDACTED]';
  return `${m.slice(0, 4)}…${m.slice(-2)}[REDACTED]`;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** Standard String.replace replacer arguments: match, ...captures. */
  replacer: (match: string, ...args: string[]) => string;
}

const RULES: Rule[] = [
  // Authorization headers (Bearer / Basic / opaque token)
  {
    name: 'auth-header',
    pattern: /\b(Authorization\s*[:=]\s*)(Bearer\s+|Basic\s+)?([A-Za-z0-9._\-+/=]{8,})/gi,
    replacer: (_m, prefix, scheme = '') => `${prefix}${scheme}[REDACTED]`,
  },
  // OpenAI-style keys
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_\-]{16,}\b/g,
    replacer: () => 'sk-[REDACTED]',
  },
  // Anthropic keys
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g,
    replacer: () => 'sk-ant-[REDACTED]',
  },
  // GitHub tokens
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacer: () => 'gh_[REDACTED]',
  },
  // AWS access key id
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{12,}\b/g,
    replacer: () => 'AKIA[REDACTED]',
  },
  // Google API key
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_\-]{20,}\b/g,
    replacer: () => 'AIza[REDACTED]',
  },
  // JWT (three base64url segments separated by dots)
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\b/g,
    replacer: () => 'eyJ[REDACTED-JWT]',
  },
  // PEM private keys (multi-line)
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    replacer: () => '[REDACTED-PRIVATE-KEY]',
  },
  // KEY=VALUE env-var-style secrets. The name must *contain* one of the
  // secret tokens as a substring, anywhere in the identifier.
  {
    name: 'env-secret',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIAL)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"']{6,})(\3)/g,
    replacer: (_m, name, sep, q, value) => `${name}${sep}${q}${shortKeep(value)}${q}`,
  },
  // Set-Cookie headers
  {
    name: 'set-cookie',
    pattern: /\b(Set-Cookie:\s*[^=]+=)([^\s;]+)/gi,
    replacer: (_m, prefix) => `${prefix}[REDACTED]`,
  },
];

/** Redact secrets in a string. Returns the (possibly identical) result. */
export function redact(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacer);
  }
  return out;
}
