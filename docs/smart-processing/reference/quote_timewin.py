#!/usr/bin/env python3
import sys, os, re, json, time, urllib.request

MODEL = "google/gemma-4-12b-qat"
API = "http://localhost:1234/v1/chat/completions"
NO_THINK = False  # qwen: append " /no_think" to user message
WIN = 1800.0
STRIDE = 1620.0

VERIFY_INSTRUCTION = """You are given a WINDOW of consecutive podcast transcript segments, each line prefixed with its index. Some windows contain one or more READ ADVERTISEMENTS, sponsor messages, or cross-promos for another show; many do not, and some contain several.

Find EVERY genuine ad / sponsor / promo read in this window. For EACH one, return its boundaries as VERBATIM quotes copied exactly from the segment text:
- first_line = the exact sentence where the hosts pivot from conversation INTO the ad (often "our show today is brought to you by X", or the opening line of the pitch).
- last_line = the exact LAST promotional sentence of that same ad - the URL, the discount code, or the sign-off ("thanks to X for supporting the show"). The ad ENDS there. The instant the hosts resume the actual topic or banter ("we're back", "so anyway", returning to the subject), that is CONTENT and must NOT be included.

RULES:
- Catch ALL of them - a 30-minute window may contain two or three separate ad reads; return one entry per ad.
- A cross-promo for another podcast or show counts as an ad/promo even with no URL or discount code - include it.
- A passing mention of a brand, product, or website during normal conversation is NOT an ad - do not include it.
- Quote EXACTLY from the provided text (so the lines can be found by string match). Copy a full distinctive sentence, not a fragment.
- If there is NO actual ad read in this window, return {"ads":[]}. When in doubt, return [] - never invent an ad in normal conversation.

EXAMPLE window:
40. [..] SPEAKER_01: and honestly that ending wrecked me, best film of the year.
41. [..] SPEAKER_01: Our show today is brought to you by Acme VPN. Going online without protection is like leaving your door unlocked.
42. [..] SPEAKER_01: Acme encrypts everything. Visit Acme.com slash show for three months free.
43. [..] SPEAKER_02: We're back. So anyway, where were we on the Scorsese thing?
CORRECT OUTPUT: {"ads":[{"first_line":"Our show today is brought to you by Acme VPN.","last_line":"Visit Acme.com slash show for three months free."}]}
(Segment 43 is content - the hosts resumed the topic - so it is excluded.)"""

SCHEMA = {"type":"json_schema","json_schema":{"name":"ads","strict":True,"schema":{"type":"object","additionalProperties":False,"required":["ads"],"properties":{"ads":{"type":"array","items":{"type":"object","additionalProperties":False,"required":["first_line","last_line"],"properties":{"first_line":{"type":"string"},"last_line":{"type":"string"}}}}}}}}

TS_RE = re.compile(r'^\[(\d+):([\d.]+)\s*-')

def parse_transcript(path):
    segs = {}  # idx -> (start_sec, text)
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.rstrip("\n")
            if not line.strip():
                continue
            m = TS_RE.match(line)
            if not m:
                continue
            start = int(m.group(1)) * 60 + float(m.group(2))
            # text after the "] " - take everything; for the user line we send full
            txt = line.split("] ", 1)[1] if "] " in line else line
            # strip "SPEAKER_xx: " prefix for matching but keep for display
            segs[i] = (start, txt)
    return segs

def norm(s):
    s = s.lower()
    # remove speaker prefix
    s = re.sub(r'^speaker_\d+:\s*', '', s)
    s = re.sub(r'[^a-z0-9 ]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def call_model(window_lines):
    user = "\n".join(window_lines)
    if NO_THINK:
        user = user + " /no_think"
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": VERIFY_INSTRUCTION},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": 4000,
        "response_format": SCHEMA,
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(API, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=590) as resp:
        r = json.load(resp)
    msg = r["choices"][0]["message"]
    content = msg.get("content") or ""
    if not content.strip():
        content = msg.get("reasoning_content") or ""
    return content

def extract_json(content):
    content = content.strip()
    # find first { ... last }
    try:
        return json.loads(content)
    except Exception:
        pass
    s = content.find("{")
    e = content.rfind("}")
    if s >= 0 and e > s:
        try:
            return json.loads(content[s:e+1])
        except Exception:
            return None
    return None

def find_seg(quote, norm_segs, idx_list):
    nq = norm(quote)
    if not nq:
        return None
    # exact containment
    for idx in idx_list:
        if nq in norm_segs[idx]:
            return idx
    # shared first ~10 words
    words = nq.split()
    if len(words) >= 3:
        prefix = " ".join(words[:10])
        for idx in idx_list:
            if prefix and prefix in norm_segs[idx]:
                return idx
    # fallback: segment that contains first 6 words
    if len(words) >= 4:
        prefix = " ".join(words[:6])
        for idx in idx_list:
            if prefix in norm_segs[idx]:
                return idx
    return None

def process(slug, path):
    segs = parse_transcript(path)
    idxs = sorted(segs.keys())
    norm_segs = {i: norm(segs[i][1]) for i in idxs}
    last_start = max(segs[i][0] for i in idxs)
    # build windows
    windows = []
    k = 0
    while True:
        lo = k * STRIDE
        hi = lo + WIN
        wsegs = [i for i in idxs if lo <= segs[i][0] < hi]
        if wsegs:
            windows.append(wsegs)
        if lo > last_start:
            break
        k += 1
    predicted = set()
    ads_returned = 0
    quote_map_failures = 0
    windows_run = 0
    for wsegs in windows:
        windows_run += 1
        lines = [f"{i}. {segs[i][1]}" for i in wsegs]
        try:
            content = call_model(lines)
        except Exception as ex:
            print(f"  [{slug}] window {windows_run} ERROR: {ex}", file=sys.stderr)
            continue
        parsed = extract_json(content)
        if not parsed or "ads" not in parsed:
            continue
        for ad in parsed["ads"]:
            ads_returned += 1
            fl = ad.get("first_line", "")
            ll = ad.get("last_line", "")
            si = find_seg(fl, norm_segs, wsegs)
            if si is None:
                quote_map_failures += 1
                continue
            ei = find_seg(ll, norm_segs, wsegs)
            if ei is None:
                ei = si
            if ei < si:
                ei = si
            for i in idxs:
                if si <= i <= ei:
                    predicted.add(i)
    out = {
        "slug": slug,
        "model": MODEL,
        "windows_run": windows_run,
        "ads_returned": ads_returned,
        "quote_map_failures": quote_map_failures,
        "predicted": sorted(predicted),
    }
    outpath = f"/tmp/eval/qtw_{MODEL.split('/')[-1]}_{slug}.json"
    with open(outpath, "w") as f:
        json.dump(out, f, indent=2)
    print(f"  [{slug}] windows={windows_run} ads={ads_returned} qmf={quote_map_failures} pred={len(predicted)} -> {outpath}", file=sys.stderr)
    return out

if __name__ == "__main__":
    if len(sys.argv) > 1:
        MODEL = sys.argv[1]
    if "qwen" in MODEL.lower():
        NO_THINK = True
    print(f"MODEL={MODEL} NO_THINK={NO_THINK}", file=sys.stderr)
    episodes = [
        {"slug":"ric","path":"/tmp/ric/transcript.txt"},
        {"slug":"threedom","path":"/tmp/eval/threedom/transcript.txt"},
        {"slug":"twit","path":"/tmp/eval/twit/transcript.txt"},
    ]
    for ep in episodes:
        process(ep["slug"], ep["path"])
