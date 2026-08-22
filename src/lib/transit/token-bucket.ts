export type TokenBucketState = {
  tokens: number;
  updatedAt: number;
};

export function consumeToken(
  state: TokenBucketState,
  refillPerSecond: number,
  capacity: number,
  now = Date.now(),
): boolean {
  const elapsedSeconds = Math.max(0, now - state.updatedAt) / 1_000;
  state.tokens = Math.min(
    capacity,
    state.tokens + elapsedSeconds * refillPerSecond,
  );
  state.updatedAt = now;
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

export async function consumeStoredToken(
  storage: Pick<DurableObjectStorage, "transaction">,
  key: string,
  refillPerSecond: number,
  capacity: number,
  now = Date.now(),
): Promise<boolean> {
  return storage.transaction(async (transaction) => {
    const state = (await transaction.get<TokenBucketState>(key)) ?? {
      tokens: capacity,
      updatedAt: now,
    };
    const allowed = consumeToken(
      state,
      refillPerSecond,
      capacity,
      now,
    );
    await transaction.put(key, state);
    return allowed;
  });
}

export class TokenBucket {
  private readonly state: TokenBucketState;

  constructor(
    private readonly refillPerSecond: number,
    private readonly capacity: number,
    now = Date.now(),
  ) {
    if (refillPerSecond <= 0 || capacity <= 0) {
      throw new Error("token bucket rates must be positive");
    }
    this.state = { tokens: capacity, updatedAt: now };
  }

  take(now = Date.now()): boolean {
    return consumeToken(
      this.state,
      this.refillPerSecond,
      this.capacity,
      now,
    );
  }
}
