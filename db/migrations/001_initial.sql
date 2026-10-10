CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE strategy_configs (
  config_hash text PRIMARY KEY,
  parameters_json jsonb NOT NULL,
  strategy_version text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), logical_key text UNIQUE NOT NULL, wallet text NOT NULL,
  strategy_version text NOT NULL, mint text NOT NULL, side text NOT NULL CHECK (side IN ('buy','sell')),
  signal_bucket timestamptz NOT NULL, amount_base_units numeric(40,0) NOT NULL CHECK (amount_base_units > 0),
  reserved_sol numeric(30,12) NOT NULL CHECK (reserved_sol >= 0), quote_json jsonb, config_hash text NOT NULL REFERENCES strategy_configs(config_hash),
  state text NOT NULL DEFAULT 'created', version integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intent_id uuid NOT NULL REFERENCES intents(id), attempt_number integer NOT NULL,
  message_hash text, signature text UNIQUE, blockhash text, validity_json jsonb, state text NOT NULL DEFAULT 'created', error text,
  submitted_at timestamptz, confirmed_at timestamptz, finalized_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intent_id, attempt_number)
);
CREATE TABLE fills (
  signature text NOT NULL, instruction_index integer NOT NULL, intent_id uuid REFERENCES intents(id), mint text NOT NULL,
  token_delta numeric(40,0) NOT NULL, sol_delta numeric(30,12) NOT NULL, fee_breakdown jsonb NOT NULL,
  commitment text NOT NULL, observed_at timestamptz NOT NULL, PRIMARY KEY(signature, instruction_index)
);
CREATE TABLE positions (
  wallet text NOT NULL, mint text NOT NULL, quantity numeric(40,0) NOT NULL, cost_basis_sol numeric(30,12) NOT NULL,
  peak_exit_value_sol numeric(30,12) NOT NULL, state text NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(wallet,mint)
);
CREATE TABLE ledger (
  id uuid PRIMARY KEY, wallet text NOT NULL, intent_id uuid REFERENCES intents(id), entry_type text NOT NULL,
  amount_sol numeric(30,12) NOT NULL, occurred_at timestamptz NOT NULL, metadata jsonb NOT NULL
);
CREATE TABLE risk_days (
  wallet text NOT NULL, utc_date date NOT NULL, opening_equity_sol numeric(30,12) NOT NULL, external_flows_sol numeric(30,12) NOT NULL,
  net_pnl_sol numeric(30,12) NOT NULL, halted boolean NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(wallet,utc_date)
);
CREATE TABLE controls (
  wallet text PRIMARY KEY, mode text NOT NULL, entry_halt boolean NOT NULL DEFAULT false, execution_halt boolean NOT NULL DEFAULT false,
  reason text, revision integer NOT NULL DEFAULT 0, liquidation_requested_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE decisions (
  id uuid PRIMARY KEY, mint text NOT NULL, signal_bucket timestamptz NOT NULL, config_hash text NOT NULL REFERENCES strategy_configs(config_hash),
  feature_snapshot jsonb NOT NULL, action text NOT NULL, reasons jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE market_events (
  event_id text PRIMARY KEY, mint text NOT NULL, slot bigint NOT NULL, signature text, instruction_index integer,
  observed_at timestamptz NOT NULL, chain_time timestamptz, commitment text NOT NULL, payload_ref text, decoder_version text NOT NULL
);
CREATE TABLE snapshots (
  id uuid PRIMARY KEY, mint text NOT NULL, slot bigint NOT NULL, reserves jsonb NOT NULL, holders jsonb NOT NULL,
  authorities jsonb NOT NULL, fees jsonb NOT NULL, captured_at timestamptz NOT NULL
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, wallet text, event_type text NOT NULL, actor text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX attempts_pending_idx ON attempts(state) WHERE state NOT IN ('finalized','failed','expired');
CREATE INDEX events_mint_slot_idx ON market_events(mint,slot);
CREATE INDEX decisions_mint_bucket_idx ON decisions(mint,signal_bucket);
