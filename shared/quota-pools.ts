// Independent quota pools of tools with more than one allowance.
export const QUOTA_POOLS = {
  antigravity: [{ ref: "gemini", label: "Gemini · " }, { ref: "claude-gpt", label: "Claude/GPT · " }],
} as const;
