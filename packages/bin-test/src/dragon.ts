import { execSync } from "node:child_process";

const runDragon = (args: string): string =>
  execSync(`dragon ${args}`, { encoding: "utf-8" }).trim();

/** Demand the dragon unleash a mighty, fire-breathing roar. */
const roar = (): string => runDragon("roar");

/** Ask the dragon how large its treasure hoard has grown. */
const hoard = (): string => runDragon("hoard");

/** Check whether the dragon is awake, asleep, or merely grumpy. */
const status = (): string => runDragon("status");

/** Offer the dragon a treat; returns the dragon's verdict on the meal. */
const feed = (treat: string): string => runDragon(`feed ${treat}`);

export { feed, hoard, roar, status };
