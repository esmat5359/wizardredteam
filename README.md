# Wizard red-team (GenLayer Studio Dev, chain 61997)

Target: **GenLayer Studio Dev**, RPC `https://studio-dev.genlayer.com/api`, chain ID `61997`, currency GEN.
Uses the `studioDevnet` preset from the genlayer-js 2.x release candidate (NOT `studionet`, which is chain 61999).
Every deploy/write sends SDK-estimated fees (`distribution` + `feeValue`) paid in GEN from the test account.

```bash
npm install
node redteam.mjs                         # test account -> try faucet RPC -> wait for GEN if balance is 0 -> deploy -> attack -> report
node redteam.mjs --fund manual           # same, but print the address first and wait for you to send GEN
node redteam.mjs --address 0x...         # attack an already deployed contract
node redteam.mjs --repeat 3 --concurrency 3
node redteam.mjs --only format,authority
node redteam.mjs --guard-file guard.txt  # set_guard (owner = account #0 or PRIVATE_KEY), then attack
node redteam.mjs --deploy                # force a fresh deployment
node redteam.mjs --extra my-attacks.json # [{"id":"x","category":"custom","text":"..."}]
node redteam.mjs --runner <hash>         # replace the py-genlayer runner hash in the contract header
node redteam.mjs --leader-tu 300 --validator-tu 600 --rotations 1,1   # bigger fee estimate
```

- Contract: `wizard_of_coin.py`; guard used at deploy: `guard.txt`.
- Keys + deployed address: `.wizard-state.json` (git-ignored, never commit). Studio Dev can be reset; a vanished saved contract is redeployed automatically.
- Env: `RPC_URL`, `CONTRACT_ADDRESS`, `PRIVATE_KEY`.
- Output: console + `report-<time>.md` / `.json`; winning prompts are under "Breaches".
