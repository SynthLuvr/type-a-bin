enum Coin {
  Gold = 7,
}

const value: number = Coin.Gold;
const args = process.argv.slice(2).join(",");

console.log(`fixture gold=${value} args=${args}`);
