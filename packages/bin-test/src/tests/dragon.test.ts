import { mockBin } from "type-a-bin";
import { afterEach, describe, expect, it } from "vitest";
import { feed, hoard, roar, status } from "../dragon.js";

describe("dragon CLI", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("roars with a torrent of flame", async () => {
    cleanup = await mockBin(
      { binName: "dragon", pattern: "roar" },
      "bash",
      'echo "RAAAAWR! The dragon unleashes a torrent of flame!"',
    );
    expect(roar()).toBe("RAAAAWR! The dragon unleashes a torrent of flame!");
  });

  it("guards a hoard of 999 gold coins", async () => {
    cleanup = await mockBin(
      { binName: "dragon", pattern: "hoard" },
      "bash",
      'echo "The dragon sleeps atop 999 gold coins."',
    );
    expect(hoard()).toBe("The dragon sleeps atop 999 gold coins.");
  });

  it("reports its status when asked", async () => {
    cleanup = await mockBin(
      { binName: "dragon", pattern: "status" },
      "bash",
      'echo "AWAKE - Mood: HUNGRY"',
    );
    expect(status()).toBe("AWAKE - Mood: HUNGRY");
  });

  it("devours whatever treat it is fed", async () => {
    cleanup = await mockBin(
      { binName: "dragon", pattern: "feed" },
      "bash",
      'echo "Nom nom nom! The dragon devours the $2."',
    );
    expect(feed("knight")).toBe("Nom nom nom! The dragon devours the knight.");
  });
});
