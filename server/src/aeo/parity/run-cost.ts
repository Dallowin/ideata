/**
 * CLI runner for checking cost parity: {model,ti,to,grounded,usdRub?} from
 * stdin (a single object or an array) → JSON {cost, fam}. usdRub overrides
 * env for the duration of the call.
 * Usage: echo '{"model":"claude-opus","ti":1000,"to":500}' | ts-node run-cost.ts
 */
import { tokenCostUsd, matchModel } from '../cost';

type In = {
  model: string | null;
  ti?: number | null;
  to?: number | null;
  grounded?: boolean;
  usdRub?: number;
};

function one(i: In): { cost: number | null; fam: string } {
  if (i.usdRub != null) process.env.USD_RUB = String(i.usdRub);
  return {
    cost: tokenCostUsd(i.model, i.ti, i.to, { grounded: i.grounded }),
    fam: matchModel(i.model),
  };
}

const src = process.argv[2]
  ? require('fs').readFileSync(process.argv[2], 'utf8')
  : require('fs').readFileSync(0, 'utf8');
const parsed = JSON.parse(src);
const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
process.stdout.write(JSON.stringify(out));
