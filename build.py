#!/usr/bin/env python3
"""
build.py — gtfs/*.zip → docs/data/{stops,network,challenges}.json

Run from repo root:
    python build.py                  # uses the newest *.zip in gtfs/
    python build.py gtfs/myfile.zip  # or point at a specific file

To update the quiz after a timetable change:
    1. Drop the new GTFS zip into gtfs/
    2. python build.py   (or just push — CI does it automatically)
"""
import csv
import glob
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict
import random

GTFS_DIR = "gtfs"
OUT_DIR  = "docs/data"
N_CHALLENGES = 30       # per difficulty level
MIN_EASY_STOPS = 5      # min stops apart for easy (same-line) challenges
RANDOM_SEED = 42

# Only include routes that have at least one trip starting in this window.
# Filters out night-only tram lines (62, 64, 69 in Kraków) automatically.
DAYTIME_START = "06:00:00"
DAYTIME_END   = "20:00:00"

# Polish character transliteration for URL-safe slugs
_PL = str.maketrans("ąćęłńóśźżĄĆĘŁŃÓŚŹŻ", "acelnoszzACELNOSZZ")

def slugify(s):
    s = s.translate(_PL).lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s or "stop"

def read_csv(zf, filename):
    raw = zf.read(filename).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(raw)))


def build_logical_stops(stops_raw):
    """Merge directional platforms into logical stops by name; return (logical, raw2log)."""
    name_groups = defaultdict(list)
    for s in stops_raw:
        name_groups[s["stop_name"]].append(s)

    logical = {}   # slug → {name, lat, lon}
    raw2log = {}   # raw stop_id → slug

    for name, group in name_groups.items():
        slug = base = slugify(name)
        i = 2
        # resolve slug collisions between different stop names
        while slug in logical and logical[slug]["name"] != name:
            slug = f"{base}_{i}"
            i += 1

        lat = sum(float(s["stop_lat"]) for s in group) / len(group)
        lon = sum(float(s["stop_lon"]) for s in group) / len(group)
        logical[slug] = {"name": name, "lat": round(lat, 6), "lon": round(lon, 6)}

        for s in group:
            raw2log[s["stop_id"]] = slug

    return logical, raw2log


def filter_daytime_routes(routes_dict, trips_raw, st_raw):
    """
    Return the subset of routes_dict whose route_id has at least one trip with a
    first-stop departure between DAYTIME_START and DAYTIME_END.

    GTFS departure_time may exceed "23:59:59" (e.g. "25:30:00") for trips that
    run past midnight — those are always night service and are excluded.
    """
    # First departure per trip, keyed by minimum stop_sequence
    trip_first_dep = {}  # trip_id → departure_time of first stop
    for st in st_raw:
        tid = st["trip_id"]
        seq = int(st["stop_sequence"])
        dep = st["departure_time"]
        if tid not in trip_first_dep or seq < trip_first_dep[tid][0]:
            trip_first_dep[tid] = (seq, dep)

    trip_route = {t["trip_id"]: t["route_id"] for t in trips_raw}

    daytime_ids = set()
    for tid, (_, dep) in trip_first_dep.items():
        rid = trip_route.get(tid)
        if rid and rid in routes_dict:
            # Exclude times >= 24 h (next-day night service)
            if int(dep.split(":")[0]) < 24 and DAYTIME_START <= dep <= DAYTIME_END:
                daytime_ids.add(rid)

    return {rid: name for rid, name in routes_dict.items() if rid in daytime_ids}


def build_network(trips_raw, st_raw, routes, raw2log):
    """
    Return (network, route_stops, stop_routes).

    network:      route_name → {name, directions: [[slug, …], …]}
    route_stops:  route_name → set of logical slugs
    stop_routes:  slug → set of route names
    """
    trip_meta = {t["trip_id"]: (t["route_id"], t["direction_id"]) for t in trips_raw}

    # Collect stop sequences per trip
    trip_seq = defaultdict(list)
    for st in st_raw:
        trip_seq[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"]))

    # Count how often each logical sequence appears per (route, direction)
    route_dir_counter = defaultdict(Counter)
    for trip_id, stops in trip_seq.items():
        if trip_id not in trip_meta:
            continue
        route_id, dir_id = trip_meta[trip_id]
        stops.sort(key=lambda x: x[0])
        seq = []
        for _, raw_id in stops:
            log = raw2log.get(raw_id)
            if log and (not seq or seq[-1] != log):   # dedupe consecutive same stop
                seq.append(log)
        if len(seq) >= 2:
            route_dir_counter[(route_id, dir_id)][tuple(seq)] += 1

    network = {}
    route_stops = defaultdict(set)

    for (route_id, _dir), counter in sorted(route_dir_counter.items()):
        rname = routes.get(route_id)
        if rname is None:
            continue   # route was filtered out (e.g. night-only line)
        canonical = list(counter.most_common(1)[0][0])
        if rname not in network:
            network[rname] = {"name": rname, "directions": []}
        network[rname]["directions"].append(canonical)
        route_stops[rname].update(canonical)

    stop_routes = defaultdict(set)
    for rname, slugs in route_stops.items():
        for slug in slugs:
            stop_routes[slug].add(rname)

    return network, route_stops, stop_routes


def min_lines(src, dst, stop_routes, route_stops):
    """
    BFS: minimum number of tram lines needed to travel from src to dst.
    Each 'step' = boarding one line and riding it to any stop it serves.
    Returns 999 if unreachable.
    """
    if src == dst:
        return 0
    visited, frontier, n = {src}, {src}, 0
    while frontier:
        n += 1
        nxt = set()
        for stop in frontier:
            for route in stop_routes[stop]:
                for nb in route_stops[route]:
                    if nb == dst:
                        return n
                    if nb not in visited:
                        visited.add(nb)
                        nxt.add(nb)
        frontier = nxt
    return 999


def generate_challenges(network, route_stops, stop_routes, logical):
    """Generate easy/normal/hard stop-pair challenges via BFS classification."""

    # Score stops by routes served — more routes = more recognisable stop.
    # Exclude stops not actually served by any route in the tram network.
    stop_score = {s: len(stop_routes[s]) for s in logical}
    all_stops = sorted(
        (s for s in logical if stop_score[s] > 0),
        key=lambda s: -stop_score[s],
    )

    seen_pairs = set()

    def try_add(src, dst, difficulty, pool):
        pair = (src, dst)
        if pair not in seen_pairs and src != dst:
            seen_pairs.add(pair)
            pool.append({"from": src, "to": dst, "difficulty": difficulty})

    easy_pool, normal_pool, hard_pool = [], [], []

    # Easy: same-line pairs ≥ MIN_EASY_STOPS apart in canonical sequence
    # Prefer pairs where both stops are well-known (high score)
    scored_easy = []
    for rname, data in network.items():
        for seq in data["directions"]:
            for i, s1 in enumerate(seq):
                for j in range(i + MIN_EASY_STOPS, len(seq)):
                    s2 = seq[j]
                    score = stop_score.get(s1, 0) + stop_score.get(s2, 0)
                    scored_easy.append((score, s1, s2))

    scored_easy.sort(key=lambda x: -x[0])
    for _, s1, s2 in scored_easy:
        if len(easy_pool) >= N_CHALLENGES:
            break
        try_add(s1, s2, "easy", easy_pool)

    # Normal / hard: BFS-classified pairs, prefer higher-scoring stops
    print("  Running BFS for normal/hard challenges…")
    candidates = [(s1, s2) for s1 in all_stops for s2 in all_stops if s1 != s2]
    random.shuffle(candidates)

    for s1, s2 in candidates:
        if len(normal_pool) >= N_CHALLENGES and len(hard_pool) >= N_CHALLENGES:
            break
        n = min_lines(s1, s2, stop_routes, route_stops)
        if n == 2 and len(normal_pool) < N_CHALLENGES:
            try_add(s1, s2, "normal", normal_pool)
        elif 3 <= n <= 10 and len(hard_pool) < N_CHALLENGES:
            try_add(s1, s2, "hard", hard_pool)

    challenges = []
    for i, c in enumerate(easy_pool):
        challenges.append({"id": f"e{i+1:02d}", **c})
    for i, c in enumerate(normal_pool):
        challenges.append({"id": f"n{i+1:02d}", **c})
    for i, c in enumerate(hard_pool):
        challenges.append({"id": f"h{i+1:02d}", **c})

    return challenges


def resolve_gtfs():
    if len(sys.argv) > 1:
        path = sys.argv[1]
        if not os.path.exists(path):
            sys.exit(f"File not found: {path}")
        return path
    zips = sorted(glob.glob(f"{GTFS_DIR}/*.zip"), key=os.path.getmtime, reverse=True)
    if not zips:
        sys.exit(f"No *.zip files found in {GTFS_DIR}/. "
                 "Drop a GTFS archive there or pass a path explicitly.")
    if len(zips) > 1:
        print(f"Multiple zips in {GTFS_DIR}/, using newest: {zips[0]}")
    return zips[0]


def main():
    random.seed(RANDOM_SEED)
    os.makedirs(OUT_DIR, exist_ok=True)

    gtfs_zip = resolve_gtfs()
    print(f"Reading GTFS from {gtfs_zip}…")
    with zipfile.ZipFile(gtfs_zip) as zf:
        routes_raw = read_csv(zf, "routes.txt")
        stops_raw  = read_csv(zf, "stops.txt")
        trips_raw  = read_csv(zf, "trips.txt")
        st_raw     = read_csv(zf, "stop_times.txt")

    routes = {r["route_id"]: r["route_short_name"] for r in routes_raw}
    routes = filter_daytime_routes(routes, trips_raw, st_raw)
    print(f"  {len(routes)} daytime routes, {len(stops_raw)} raw stops, "
          f"{len(trips_raw)} trips, {len(st_raw)} stop-times")

    print("Building logical stops…")
    logical, raw2log = build_logical_stops(stops_raw)
    print(f"  {len(logical)} logical stops")

    print("Building network…")
    network, route_stops, stop_routes = build_network(
        trips_raw, st_raw, routes, raw2log
    )
    print(f"  {len(network)} routes with canonical sequences")

    print("Generating challenges…")
    challenges = generate_challenges(network, route_stops, stop_routes, logical)

    counts = Counter(c["difficulty"] for c in challenges)
    print(f"  easy={counts['easy']}  normal={counts['normal']}  hard={counts['hard']}")

    print("Writing output…")
    with open(f"{OUT_DIR}/stops.json", "w", encoding="utf-8") as f:
        json.dump(logical, f, ensure_ascii=False, indent=2)

    with open(f"{OUT_DIR}/network.json", "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, indent=2)

    with open(f"{OUT_DIR}/challenges.json", "w", encoding="utf-8") as f:
        json.dump(challenges, f, ensure_ascii=False, indent=2)

    print(f"Done → {OUT_DIR}/")


if __name__ == "__main__":
    main()
