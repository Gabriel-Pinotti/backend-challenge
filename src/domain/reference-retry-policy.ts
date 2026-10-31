export interface ReferenceRetryPolicyProps {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class ReferenceRetryPolicy {
  constructor(private readonly props: ReferenceRetryPolicyProps) {}

  isExhausted(attempts: number): boolean {
    return attempts >= this.props.maxAttempts;
  }

  nextAttemptAt(attempts: number, now: Date): Date {
    const delay = Math.min(
      this.props.baseDelayMs * 2 ** attempts,
      this.props.maxDelayMs,
    );
    return new Date(now.getTime() + delay);
  }
}
