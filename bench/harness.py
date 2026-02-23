#!/usr/bin/env python3
"""
Benchmark harness — main runner that dispatches scenarios.

Usage (inside container):
  python3 /bench/harness.py --scenario s1_write_overhead --output /bench/results/raw/s1.json
  python3 /bench/harness.py --scenario s2_delta_latency --output /bench/results/raw/s2.json
  python3 /bench/harness.py --scenario s3_query_complexity --output /bench/results/raw/s3.json
  python3 /bench/harness.py --scenario s4_result_set_scale --output /bench/results/raw/s4.json
  python3 /bench/harness.py --scenario s5_subscription_scale --output /bench/results/raw/s5.json

Optional:
  --approaches pgr,ivm,poll    Comma-separated list of approaches to test
  --param key=value            Pass parameters to scenarios (e.g. scale=1000)
  --duration N                 Override benchmark duration in seconds (default: 10)
"""

import argparse
import json
import os
import sys
import time
import psycopg2

# Add bench dir to path
sys.path.insert(0, os.path.dirname(__file__))

from approaches.base import load_queries

DB = os.environ.get("BENCH_DB", "bench_db")
USER = os.environ.get("BENCH_USER", "postgres")
HOST = os.environ.get("BENCH_HOST", "localhost")
PORT = int(os.environ.get("BENCH_PORT", "5432"))

TIER1_APPROACHES = ["pgr", "ivm", "poll", "notify"]


def connect(autocommit=False):
    conn = psycopg2.connect(dbname=DB, user=USER, host=HOST, port=PORT)
    conn.autocommit = autocommit
    return conn


def load_approach(name):
    """Dynamically load an approach adapter by name."""
    if name == "pgr":
        from approaches.pgr import PgrApproach
        return PgrApproach()
    elif name == "ivm":
        from approaches.ivm import IvmApproach
        return IvmApproach()
    elif name == "poll":
        from approaches.poll import PollApproach
        return PollApproach()
    elif name == "notify":
        from approaches.notify import NotifyApproach
        return NotifyApproach()
    elif name == "hasura":
        from approaches.hasura import HasuraApproach
        return HasuraApproach()
    elif name == "debezium":
        from approaches.debezium import DebeziumApproach
        return DebeziumApproach()
    elif name == "supabase":
        from approaches.supabase import SupabaseApproach
        return SupabaseApproach()
    elif name == "electric":
        from approaches.electric import ElectricApproach
        return ElectricApproach()
    else:
        raise ValueError(f"Unknown approach: {name}")


def run_scenario(scenario_name, approaches, params, duration):
    """Import and run a scenario module."""
    if scenario_name == "s1_write_overhead":
        from scenarios.s1_write_overhead import run
    elif scenario_name == "s2_delta_latency":
        from scenarios.s2_delta_latency import run
    elif scenario_name == "s3_query_complexity":
        from scenarios.s3_query_complexity import run
    elif scenario_name == "s4_result_set_scale":
        from scenarios.s4_result_set_scale import run
    elif scenario_name == "s5_subscription_scale":
        from scenarios.s5_subscription_scale import run
    else:
        print(f"Unknown scenario: {scenario_name}", file=sys.stderr)
        sys.exit(1)

    adapters = [load_approach(a) for a in approaches]
    queries = load_queries("/bench/queries.sql")

    return run(
        adapters=adapters,
        queries=queries,
        connect_fn=connect,
        params=params,
        duration=duration,
    )


def main():
    parser = argparse.ArgumentParser(description="pg_reactive benchmark harness")
    parser.add_argument("--scenario", required=True, help="Scenario to run")
    parser.add_argument("--output", required=True, help="Output JSON path")
    parser.add_argument("--approaches", default=None,
                        help="Comma-separated approaches (default: Tier 1)")
    parser.add_argument("--param", action="append", default=[],
                        help="key=value parameters for scenarios")
    parser.add_argument("--duration", type=int, default=10,
                        help="Benchmark duration in seconds")
    args = parser.parse_args()

    # Parse approaches
    if args.approaches:
        approach_names = args.approaches.split(",")
    else:
        approach_names = TIER1_APPROACHES

    # Parse params
    params = {}
    for p in args.param:
        k, v = p.split("=", 1)
        params[k] = v

    print(f"=== Scenario: {args.scenario} ===")
    print(f"Approaches: {approach_names}")
    print(f"Duration: {args.duration}s")
    if params:
        print(f"Params: {params}")
    print()

    results = run_scenario(args.scenario, approach_names, params, args.duration)

    # Write output
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\nResults written to {args.output}")


if __name__ == "__main__":
    main()
