import type { RoomPolicy } from "../../do/room";

export type RoomSummary = {
  name: string;
  policy: RoomPolicy;
  created_at: number;
};

type CreateRoomInput = {
  org: string;
  name: string;
  policy: RoomPolicy;
  creator?: string;
};

export async function createRoom(
  env: Env,
  input: CreateRoomInput,
): Promise<{ created: true; room: RoomSummary } | { created: false }> {
  const existing = await env.DB.prepare(
    "SELECT 1 AS present FROM room WHERE org_id = ? AND name = ? LIMIT 1",
  )
    .bind(input.org, input.name)
    .first();
  if (existing) return { created: false };

  const createdAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO room (org_id, name, policy, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(input.org, input.name, input.policy, createdAt)
    .run();

  const room = env.ROOM.getByName(`org:${input.org}:room:${input.name}`);
  await room.configure({
    org: input.org,
    name: input.name,
    policy: input.policy,
    createdAt,
  });
  if (input.creator) {
    const joined = await room.join(input.creator, "creator");
    if (joined.error) throw new Error(joined.error);
  }

  return {
    created: true,
    room: { name: input.name, policy: input.policy, created_at: createdAt },
  };
}
