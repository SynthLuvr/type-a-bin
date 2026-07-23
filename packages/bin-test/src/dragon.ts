import { execSync } from "node:child_process";

const runDragon = (args: string): string =>
  execSync(`dragon ${args}`, { encoding: "utf-8" }).trim();

const roar = (): string => runDragon("roar");

const hoard = (): string => runDragon("hoard");

const status = (): string => runDragon("status");

const feed = (treat: string): string => runDragon(`feed ${treat}`);

export { feed, hoard, roar, status };
