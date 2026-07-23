import { mockBin } from "type-a-bin";
import { afterEach, describe, expect, it } from "vitest";
import { feed, hoard, roar, status } from "../dragon.js";

const mockDragon = (pattern: string, script: string) =>
  mockBin({ binName: "dragon", pattern }, "bash", script);

describe("dragon CLI", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("roars with a torrent of flame", async () => {
    const reply = "RAAAAWR! The dragon unleashes a torrent of flame!";
    cleanup = await mockDragon("roar", `echo "${reply}"`);
    expect(roar()).toBe(reply);
  });

  it("guards a hoard of 999 gold coins", async () => {
    const reply = "The dragon sleeps atop 999 gold coins.";
    cleanup = await mockDragon("hoard", `echo "${reply}"`);
    expect(hoard()).toBe(reply);
  });

  it("reports its status when asked", async () => {
    const reply = "AWAKE - Mood: HUNGRY";
    cleanup = await mockDragon("status", `echo "${reply}"`);
    expect(status()).toBe(reply);
  });

  it("devours whatever treat it is fed", async () => {
    cleanup = await mockDragon(
      "feed",
      'echo "Nom nom nom! The dragon devours the $2."',
    );
    expect(feed("knight")).toBe("Nom nom nom! The dragon devours the knight.");
  });
});
