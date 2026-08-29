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
    const reply = "RAAAAWR! The dragon unleashes a torrent of flame!";
    cleanup = await mockBin({ binName: "dragon", pattern: "roar" }, reply);
    expect(roar()).toBe(reply);
  });

  it("guards a hoard of 999 gold coins", async () => {
    const reply = "The dragon sleeps atop 999 gold coins.";
    cleanup = await mockBin({ binName: "dragon", pattern: "hoard" }, reply);
    expect(hoard()).toBe(reply);
  });

  it("reports its status when asked", async () => {
    const reply = "AWAKE - Mood: HUNGRY";
    cleanup = await mockBin({ binName: "dragon", pattern: "status" }, reply);
    expect(status()).toBe(reply);
  });

  it("records the arguments the CLI passed to the binary", async () => {
    const dragon = await mockBin("dragon", { stdout: "Nom nom nom!" });
    cleanup = dragon;

    expect(feed("knight")).toBe("Nom nom nom!");
    expect(dragon.calls.map((call) => call.args)).toEqual([["feed", "knight"]]);
  });

  it("devours whatever treat it is fed", async () => {
    cleanup = await mockBin(
      { binName: "dragon", pattern: "feed" },
      "Nom nom nom! The dragon devours the $2.",
    );
    expect(feed("knight")).toBe("Nom nom nom! The dragon devours the knight.");
  });
});
