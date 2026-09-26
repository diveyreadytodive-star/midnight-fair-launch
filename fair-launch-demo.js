export class DemoInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoInputError';
  }
}

function positiveInteger(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) throw new DemoInputError(`${name} must be a positive integer.`);
  return BigInt(text);
}

// Mirrors the current four-slot Compact settlement rules. This is a browser
// calculation, not a proof, transaction, or replay of the recorded chain run.
export function simulateFourSlotAuction({ inventory, reserve, deposit, bids }) {
  const supply = positiveInteger(inventory, 'Inventory');
  const floor = positiveInteger(reserve, 'Reserve price');
  const lot = positiveInteger(deposit, 'Deposit lot');
  if (!Array.isArray(bids) || bids.length !== 4) throw new DemoInputError('Exactly four bid slots are required.');

  const parsed = bids.map((bid, index) => {
    const price = positiveInteger(bid?.price, `Slot ${index + 1} maximum price`);
    const quantity = positiveInteger(bid?.quantity, `Slot ${index + 1} quantity`);
    if (price < floor) throw new DemoInputError(`Slot ${index + 1} is below the reserve price.`);
    if (price * quantity > lot) throw new DemoInputError(`Slot ${index + 1} exceeds its fixed deposit lot.`);
    return { price, quantity };
  });

  const totalDemand = parsed.reduce((sum, bid) => sum + bid.quantity, 0n);
  const oversubscribed = totalDemand >= supply;
  let clearing = floor;
  if (oversubscribed) {
    let accumulated = 0n;
    for (const price of [...new Set(parsed.map((bid) => bid.price))].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)) {
      accumulated += parsed.filter((bid) => bid.price === price).reduce((sum, bid) => sum + bid.quantity, 0n);
      if (accumulated >= supply) {
        clearing = price;
        break;
      }
    }
  }

  const higherDemand = parsed.filter((bid) => bid.price > clearing).reduce((sum, bid) => sum + bid.quantity, 0n);
  const marginalDemand = parsed.filter((bid) => bid.price === clearing).reduce((sum, bid) => sum + bid.quantity, 0n);
  const remaining = supply - higherDemand;
  const allocations = [];
  for (const bid of parsed) {
    if (bid.price < clearing) allocations.push(0n);
    else if (!oversubscribed || bid.price > clearing) allocations.push(bid.quantity);
    else {
      const numerator = bid.quantity * remaining;
      if (numerator % marginalDemand !== 0n) {
        return { status: 'non-integral', clearingPrice: clearing.toString() };
      }
      allocations.push(numerator / marginalDemand);
    }
  }

  const paid = allocations.map((amount) => amount * clearing);
  if (paid.some((amount) => amount > lot)) throw new DemoInputError('Settlement exceeds a deposit lot.');
  const refunds = paid.map((amount) => lot - amount);
  const sold = allocations.reduce((sum, amount) => sum + amount, 0n);
  if (sold > supply || refunds.reduce((sum, amount) => sum + amount, 0n) + paid.reduce((sum, amount) => sum + amount, 0n) !== lot * 4n) {
    throw new DemoInputError('Settlement conservation check failed.');
  }
  return {
    status: 'settled',
    clearingPrice: clearing.toString(),
    allocations: allocations.map(String),
    refunds: refunds.map(String),
    proceeds: paid.reduce((sum, amount) => sum + amount, 0n).toString(),
    unsold: (supply - sold).toString(),
  };
}
