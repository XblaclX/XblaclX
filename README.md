# .github/workflows/profile-readme.yml
name: Build animated profile

on:
  workflow_dispatch:
  schedule:
    - cron: "17 6 * * *"
  push:
    paths:
      - ".github/workflows/profile-readme.yml"

permissions:
  contents: write

concurrency:
  group: animated-profile-${{ github.ref }}
  cancel-in-progress: true

env:
  GITHUB_PROFILE_USER: ${{ github.repository_owner }}
  PROFILE_TAGLINE: ${{ vars.PROFILE_TAGLINE }}

jobs:
  render:
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Render self-hosted animated profile
        shell: bash
        run: |
          python - <<'PY'
          from __future__ import annotations

          import datetime as dt
          import hashlib
          import html
          import json
          import math
          import os
          import random
          import re
          import time
          import urllib.error
          import urllib.request
          from collections import defaultdict
          from html.parser import HTMLParser
          from pathlib import Path

          USERNAME = os.environ.get("GITHUB_PROFILE_USER", "").strip()
          TAGLINE_OVERRIDE = os.environ.get("PROFILE_TAGLINE", "").strip()

          SVG_PATH = Path("profile.svg")
          README_PATH = Path("README.md")

          WIDTH = 960
          HEIGHT = 690

          if not USERNAME:
              raise SystemExit("GITHUB_PROFILE_USER is empty")


          def fetch_text(url: str, *, accept: str = "text/html") -> str:
              headers = {
                  "User-Agent": "github-profile-svg/1.0 (+https://github.com)",
                  "Accept": accept,
                  "Accept-Language": "en-US,en;q=0.9",
              }

              last_error: Exception | None = None

              for attempt in range(4):
                  try:
                      request = urllib.request.Request(url, headers=headers)

                      with urllib.request.urlopen(request, timeout=25) as response:
                          return response.read().decode(
                              "utf-8",
                              errors="replace",
                          )

                  except (
                      urllib.error.URLError,
                      urllib.error.HTTPError,
                      TimeoutError,
                  ) as exc:
                      last_error = exc

                      if attempt == 3:
                          break

                      time.sleep(1.2 * (2**attempt))

              raise RuntimeError(
                  f"Unable to fetch {url}: {last_error}"
              )


          class ContributionParser(HTMLParser):
              def __init__(self) -> None:
                  super().__init__(convert_charrefs=True)

                  self.cells: list[dict[str, str]] = []
                  self.tooltips: dict[str, str] = {}

                  self._tooltip_for: str | None = None
                  self._tooltip_text: list[str] = []

              def handle_starttag(
                  self,
                  tag: str,
                  attrs: list[tuple[str, str | None]],
              ) -> None:
                  data = {
                      key: value or ""
                      for key, value in attrs
                  }

                  classes = set(
                      data.get("class", "").split()
                  )

                  if (
                      data.get("data-date")
                      and (
                          "ContributionCalendar-day" in classes
                          or data.get("data-level")
                      )
                  ):
                      self.cells.append(data)

                  elif (
                      tag == "tool-tip"
                      and data.get("for")
                  ):
                      self._tooltip_for = data["for"]
                      self._tooltip_text = []

              def handle_data(self, data: str) -> None:
                  if self._tooltip_for is not None:
                      self._tooltip_text.append(data)

              def handle_endtag(self, tag: str) -> None:
                  if (
                      tag == "tool-tip"
                      and self._tooltip_for is not None
                  ):
                      self.tooltips[self._tooltip_for] = (
                          "".join(self._tooltip_text).strip()
                      )

                      self._tooltip_for = None
                      self._tooltip_text = []


          def parse_contributions(
              markup: str,
          ) -> dict[dt.date, int]:

              parser = ContributionParser()
              parser.feed(markup)

              if not parser.cells:
                  raise RuntimeError(
                      "GitHub contribution cells were not found; "
                      "markup may have changed"
                  )

              by_day: dict[dt.date, int] = {}

              for cell in parser.cells:
                  try:
                      day = dt.date.fromisoformat(
                          cell["data-date"]
                      )
                  except ValueError:
                      continue

                  raw_count = (
                      cell
                      .get("data-count", "")
                      .replace(",", "")
                  )

                  if raw_count.isdigit():
                      count = int(raw_count)

                  else:
                      label = (
                          cell.get("aria-label", "")
                          or parser.tooltips.get(
                              cell.get("id", ""),
                              "",
                          )
                      )

                      match = re.search(
                          r"([\d,]+)\s+contribution",
                          label,
                          flags=re.IGNORECASE,
                      )

                      count = (
                          int(
                              match.group(1).replace(",", "")
                          )
                          if match
                          else 0
                      )

                  by_day[day] = max(
                      by_day.get(day, 0),
                      count,
                  )

              if not by_day:
                  raise RuntimeError(
                      "GitHub contribution dates could not be parsed"
                  )

              latest = max(by_day)

              current_week_start = (
                  latest
                  - dt.timedelta(
                      days=(latest.weekday() + 1) % 7
                  )
              )

              grid_start = (
                  current_week_start
                  - dt.timedelta(weeks=52)
              )

              return {
                  day: count
                  for day, count in by_day.items()
                  if grid_start <= day <= latest
              }


          def fetch_profile() -> dict:
              try:
                  raw = fetch_text(
                      f"https://api.github.com/users/{USERNAME}",
                      accept="application/vnd.github+json",
                  )

                  data = json.loads(raw)

                  return (
                      data
                      if isinstance(data, dict)
                      else {}
                  )

              except Exception:
                  return {}


          def esc(value: object) -> str:
              return html.escape(
                  str(value),
                  quote=False,
              )


          def clip(
              value: object,
              length: int,
          ) -> str:

              text = re.sub(
                  r"\s+",
                  " ",
                  str(value or ""),
              ).strip()

              if len(text) <= length:
                  return text

              return (
                  text[: max(0, length - 1)]
                  .rstrip()
                  + "…"
              )


          def fmt_int(
              value: int | None,
          ) -> str:
              return (
                  f"{value:,}"
                  if value is not None
                  else "—"
              )


          def stats_for(
              days: dict[dt.date, int],
          ) -> dict:

              latest = max(days)

              current_week_start = (
                  latest
                  - dt.timedelta(
                      days=(latest.weekday() + 1) % 7
                  )
              )

              grid_start = (
                  current_week_start
                  - dt.timedelta(weeks=52)
              )

              ordered_dates = [
                  grid_start + dt.timedelta(days=index)
                  for index in range(
                      (latest - grid_start).days + 1
                  )
              ]

              counts = [
                  days.get(day, 0)
                  for day in ordered_dates
              ]

              total = sum(counts)

              active = sum(
                  value > 0
                  for value in counts
              )

              best_day = max(
                  ordered_dates,
                  key=lambda day: days.get(day, 0),
              )

              best_count = days.get(
                  best_day,
                  0,
              )

              end_idx = len(counts) - 1

              if (
                  end_idx >= 0
                  and counts[end_idx] == 0
              ):
                  end_idx -= 1

              current = 0

              while (
                  end_idx >= 0
                  and counts[end_idx] > 0
              ):
                  current += 1
                  end_idx -= 1

              longest = 0
              run = 0

              for value in counts:
                  if value > 0:
                      run += 1
                      longest = max(
                          longest,
                          run,
                      )
                  else:
                      run = 0

              months: dict[str, int] = defaultdict(int)

              for day in ordered_dates:
                  months[
                      day.strftime("%Y-%m")
                  ] += days.get(day, 0)

              return {
                  "latest": latest,
                  "grid_start": grid_start,
                  "total": total,
                  "active": active,
                  "current": current,
                  "longest": longest,
                  "best_day": best_day,
                  "best_count": best_count,
                  "months": dict(
                      sorted(
                          months.items()
                      )[-12:]
                  ),
              }


          def contribution_level(
              count: int,
              maximum: int,
          ) -> int:

              if (
                  count <= 0
                  or maximum <= 0
              ):
                  return 0

              normalized = (
                  math.log1p(count)
                  / math.log1p(maximum)
              )

              return max(
                  1,
                  min(
                      5,
                      math.ceil(
                          normalized * 5
                      ),
                  ),
              )


          def identicon(
              username: str,
              x: float,
              y: float,
          ) -> str:

              digest = hashlib.sha256(
                  username.encode("utf-8")
              ).digest()

              cell = 10
              gap = 4
              size = 9
              step = cell + gap

              out: list[str] = []

              for row in range(size):
                  for col in range(
                      (size + 1) // 2
                  ):
                      byte = digest[
                          (row * 5 + col)
                          % len(digest)
                      ]

                      on = (
                          (
                              byte
                              >> (
                                  (row + col)
                                  % 8
                              )
                          )
                          & 1
                      ) == 1

                      if not on:
                          continue

                      mirrors = {
                          col,
                          size - 1 - col,
                      }

                      for actual_col in mirrors:
                          px = (
                              x
                              + actual_col * step
                          )

                          py = (
                              y
                              + row * step
                          )

                          distance = (
                              abs(row - 4)
                              + abs(
                                  actual_col - 4
                              )
                          )

                          delay = (
                              0.7
                              + distance * 0.045
                          )

                          out.append(
                              f'<rect '
                              f'x="{px:.1f}" '
                              f'y="{py:.1f}" '
                              f'width="{cell}" '
                              f'height="{cell}" '
                              f'rx="2.5" '
                              f'fill="url(#neon)" '
                              f'opacity="0">'
                              f'<animate '
                              f'attributeName="opacity" '
                              f'from="0" '
                              f'to="0.92" '
                              f'begin="{delay:.2f}s" '
                              f'dur="0.38s" '
                              f'fill="freeze"/>'
                              f'</rect>'
                          )

              return "".join(out)


          profile = fetch_profile()

          contribution_html = fetch_text(
              f"https://github.com/users/"
              f"{USERNAME}/contributions"
          )

          days = parse_contributions(
              contribution_html
          )

          s = stats_for(days)

          name = clip(
              profile.get("name")
              or USERNAME,
              38,
          )

          tagline = clip(
              TAGLINE_OVERRIDE
              or profile.get("bio")
              or "github profile // live activity",
              76,
          )

          company = clip(
              profile.get("company") or "",
              24,
          )

          location = clip(
              profile.get("location") or "",
              22,
          )

          website = clip(
              profile.get("blog") or "",
              28,
          )

          profile_ok = (
              str(
                  profile.get("login")
                  or ""
              ).lower()
              == USERNAME.lower()
          )

          public_repos = (
              int(
                  profile.get(
                      "public_repos"
                  )
                  or 0
              )
              if profile_ok
              else None
          )

          followers = (
              int(
                  profile.get(
                      "followers"
                  )
                  or 0
              )
              if profile_ok
              else None
          )

          following = (
              int(
                  profile.get(
                      "following"
                  )
                  or 0
              )
              if profile_ok
              else None
          )

          created = str(
              profile.get(
                  "created_at"
              )
              or ""
          )[:4]

          meta_parts = [
              part
              for part in (
                  company,
                  location,
                  (
                      f"GitHub since {created}"
                      if created
                      else ""
                  ),
              )
              if part
          ]

          meta = (
              "  ·  ".join(meta_parts)
              or "public profile"
          )

          web_line = (
              website
              if website
              else f"github.com/{USERNAME}"
          )

          latest: dt.date = s["latest"]
          grid_start: dt.date = s["grid_start"]

          maximum = (
              max(days.values())
              if days
              else 0
          )

          palette = [
              "#111827",
              "#123b3a",
              "#0f6b57",
              "#109f76",
              "#18c99a",
              "#64ffda",
          ]

          heat_x = 56
          heat_y = 394

          cell = 8.8
          gap = 3.0
          step = cell + gap

          heatmap_parts: list[str] = []

          for week in range(53):
              for weekday in range(7):
                  day = (
                      grid_start
                      + dt.timedelta(
                          days=week * 7
                          + weekday
                      )
                  )

                  if day > latest:
                      continue

                  count = days.get(
                      day,
                      0,
                  )

                  level = contribution_level(
                      count,
                      maximum,
                  )

                  x = (
                      heat_x
                      + week * step
                  )

                  y = (
                      heat_y
                      + weekday * step
                  )

                  delay = (
                      1.55
                      + week * 0.017
                      + weekday * 0.025
                  )

                  heatmap_parts.append(
                      f'<rect '
                      f'x="{x:.1f}" '
                      f'y="{y:.1f}" '
                      f'width="{cell:.1f}" '
                      f'height="{cell:.1f}" '
                      f'rx="2.2" '
                      f'fill="{palette[level]}" '
                      f'opacity="0" '
                      f'transform="translate(0 -7)">'

                      f'<title>'
                      f'{esc(day.isoformat())}: '
                      f'{count} contribution'
                      f'{"s" if count != 1 else ""}'
                      f'</title>'

                      f'<animate '
                      f'attributeName="opacity" '
                      f'from="0" '
                      f'to="1" '
                      f'begin="{delay:.3f}s" '
                      f'dur="0.32s" '
                      f'fill="freeze"/>'

                      f'<animateTransform '
                      f'attributeName="transform" '
                      f'type="translate" '
                      f'from="0 -7" '
                      f'to="0 0" '
                      f'begin="{delay:.3f}s" '
                      f'dur="0.32s" '
                      f'fill="freeze"/>'

                      f'</rect>'
                  )

          month_labels: list[str] = []

          last_week = -10
          cursor = grid_start

          while cursor <= latest:
              if (
                  cursor.day == 1
                  or cursor == grid_start
              ):
                  week = (
                      cursor - grid_start
                  ).days // 7

                  if (
                      week - last_week
                      >= 4
                  ):
                      month_labels.append(
                          f'<text '
                          f'x="{heat_x + week * step:.1f}" '
                          f'y="380" '
                          f'class="micro muted">'
                          f'{esc(cursor.strftime("%b"))}'
                          f'</text>'
                      )

                      last_week = week

              cursor += dt.timedelta(
                  days=1
              )

          month_values = list(
              s["months"].items()
          )

          bar_x = 61
          bar_y = 596

          bar_w = 54
          bar_gap = 10
          max_bar_h = 52

          max_month = max(
              (
                  value
                  for _, value
                  in month_values
              ),
              default=1,
          )

          month_bars: list[str] = []

          for index, (
              month,
              value,
          ) in enumerate(
              month_values
          ):
              h = (
                  6
                  + (
                      value
                      / max_month
                  )
                  * (
                      max_bar_h
                      - 6
                  )
                  if max_month
                  else 6
              )

              x = (
                  bar_x
                  + index
                  * (
                      bar_w
                      + bar_gap
                  )
              )

              y = bar_y - h

              delay = (
                  2.2
                  + index * 0.06
              )

              label = (
                  dt.datetime
                  .strptime(
                      month,
                      "%Y-%m",
                  )
                  .strftime("%b")
              )

              month_bars.append(
                  f'<rect '
                  f'x="{x}" '
                  f'y="{bar_y}" '
                  f'width="{bar_w}" '
                  f'height="0" '
                  f'rx="4" '
                  f'fill="url(#barGradient)" '
                  f'opacity="0.78">'

                  f'<animate '
                  f'attributeName="y" '
                  f'from="{bar_y}" '
                  f'to="{y:.1f}" '
                  f'begin="{delay:.2f}s" '
                  f'dur="0.55s" '
                  f'fill="freeze"/>'

                  f'<animate '
                  f'attributeName="height" '
                  f'from="0" '
                  f'to="{h:.1f}" '
                  f'begin="{delay:.2f}s" '
                  f'dur="0.55s" '
                  f'fill="freeze"/>'

                  f'</rect>'

                  f'<text '
                  f'x="{x + bar_w / 2:.1f}" '
                  f'y="614" '
                  f'text-anchor="middle" '
                  f'class="micro muted">'
                  f'{label}'
                  f'</text>'
              )

          seed = int(
              hashlib.sha256(
                  USERNAME.encode()
              ).hexdigest()[:16],
              16,
          )

          rng = random.Random(seed)

          particles: list[str] = []

          for _ in range(34):
              x = rng.uniform(
                  22,
                  WIDTH - 22,
              )

              y = rng.uniform(
                  74,
                  HEIGHT - 42,
              )

              r = rng.choice(
                  (
                      0.55,
                      0.7,
                      0.9,
                      1.1,
                  )
              )

              opacity = rng.uniform(
                  0.08,
                  0.22,
              )

              duration = rng.uniform(
                  2.4,
                  5.8,
              )

              begin = rng.uniform(
                  0,
                  2.0,
              )

              particles.append(
                  f'<circle '
                  f'cx="{x:.1f}" '
                  f'cy="{y:.1f}" '
                  f'r="{r}" '
                  f'fill="#7dd3fc" '
                  f'opacity="{opacity:.2f}">'

                  f'<animate '
                  f'attributeName="opacity" '
                  f'values="'
                  f'{opacity:.2f};'
                  f'{min(0.45, opacity * 2.4):.2f};'
                  f'{opacity:.2f}" '
                  f'dur="{duration:.2f}s" '
                  f'begin="{begin:.2f}s" '
                  f'repeatCount="indefinite"/>'

                  f'</circle>'
              )

          ident_hash = (
              hashlib.sha256(
                  USERNAME.encode()
              )
              .hexdigest()[:10]
          )

          generated = (
              dt.datetime
              .now(dt.timezone.utc)
              .strftime(
                  "%Y-%m-%d %H:%M UTC"
              )
          )

          svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-labelledby="title desc">
          <title id="title">Animated GitHub profile for @{esc(USERNAME)}</title>
          <desc id="desc">Self-hosted animated terminal profile with live public GitHub contribution data.</desc>

          <defs>
            <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#7c3aed">
                <animate
                  attributeName="stop-color"
                  values="#7c3aed;#22d3ee;#34d399;#7c3aed"
                  dur="9s"
                  repeatCount="indefinite"
                />
              </stop>

              <stop offset="0.5" stop-color="#22d3ee">
                <animate
                  attributeName="stop-color"
                  values="#22d3ee;#34d399;#a78bfa;#22d3ee"
                  dur="9s"
                  repeatCount="indefinite"
                />
              </stop>

              <stop offset="1" stop-color="#34d399">
                <animate
                  attributeName="stop-color"
                  values="#34d399;#a78bfa;#22d3ee;#34d399"
                  dur="9s"
                  repeatCount="indefinite"
                />
              </stop>
            </linearGradient>

            <linearGradient id="neon" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stop-color="#64ffda"/>
              <stop offset="0.55" stop-color="#22d3ee"/>
              <stop offset="1" stop-color="#a78bfa"/>
            </linearGradient>

            <linearGradient id="barGradient" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stop-color="#0f6b57"/>
              <stop offset="1" stop-color="#64ffda"/>
            </linearGradient>

            <radialGradient id="bgGlow" cx="75%" cy="18%" r="80%">
              <stop offset="0" stop-color="#12223a" stop-opacity="0.92"/>
              <stop offset="0.45" stop-color="#0d1526" stop-opacity="0.98"/>
              <stop offset="1" stop-color="#070b14"/>
            </radialGradient>

            <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.5" result="blur"/>
              <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>

            <filter id="tinyGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.6" result="blur"/>
              <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>

            <pattern
              id="grid"
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 24 0 L 0 0 0 24"
                fill="none"
                stroke="#253249"
                stroke-width="0.55"
                opacity="0.24"
              />
            </pattern>

            <clipPath id="nameReveal">
              <rect
                x="0"
                y="0"
                width="0"
                height="50"
              >
                <animate
                  attributeName="width"
                  from="0"
                  to="620"
                  begin="0.35s"
                  dur="1.05s"
                  fill="freeze"
                />
              </rect>
            </clipPath>

            <clipPath id="tagReveal">
              <rect
                x="0"
                y="0"
                width="0"
                height="34"
              >
                <animate
                  attributeName="width"
                  from="0"
                  to="620"
                  begin="1.0s"
                  dur="1.15s"
                  fill="freeze"
                />
              </rect>
            </clipPath>
          </defs>

          <style>
            .mono {{
              font-family:
                ui-monospace,
                SFMono-Regular,
                Menlo,
                Monaco,
                Consolas,
                "Liberation Mono",
                "Courier New",
                monospace;
            }}

            .text {{
              fill: #d7e3f4;
            }}

            .bright {{
              fill: #f8fbff;
            }}

            .muted {{
              fill: #7e8ca6;
            }}

            .green {{
              fill: #64ffda;
            }}

            .cyan {{
              fill: #67e8f9;
            }}

            .violet {{
              fill: #c4b5fd;
            }}

            .micro {{
              font:
                10px
                ui-monospace,
                SFMono-Regular,
                Menlo,
                Monaco,
                Consolas,
                monospace;

              letter-spacing: .35px;
            }}

            .small {{
              font:
                12px
                ui-monospace,
                SFMono-Regular,
                Menlo,
                Monaco,
                Consolas,
                monospace;
            }}

            .body {{
              font:
                14px
                ui-monospace,
                SFMono-Regular,
                Menlo,
                Monaco,
                Consolas,
                monospace;
            }}

            .metric {{
              font:
                700
                21px
                ui-monospace,
                SFMono-Regular,
                Menlo,
                Monaco,
                Consolas,
                monospace;
            }}

            .hero {{
              font:
                800
                34px
                ui-monospace,
                SFMono-Regular,
                Menlo,
                Monaco,
                Consolas,
                monospace;

              letter-spacing: -1.2px;
            }}
          </style>

          <rect
            x="1"
            y="1"
            width="958"
            height="688"
            rx="22"
            fill="url(#bgGlow)"
            stroke="url(#frame)"
            stroke-width="2"
          />

          <rect
            x="10"
            y="10"
            width="940"
            height="670"
            rx="17"
            fill="url(#grid)"
            opacity="0.42"
          />

          {''.join(particles)}

          <g opacity="0.92">
            <rect
              x="18"
              y="18"
              width="924"
              height="48"
              rx="12"
              fill="#0b1220"
              stroke="#253047"
            />

            <circle
              cx="40"
              cy="42"
              r="5"
              fill="#ff5f57"
            />

            <circle
              cx="58"
              cy="42"
              r="5"
              fill="#febc2e"
            />

            <circle
              cx="76"
              cy="42"
              r="5"
              fill="#28c840"
            />

            <text
              x="102"
              y="47"
              class="small muted mono"
            >{esc(USERNAME)}@github:~</text>

            <text
              x="820"
              y="47"
              class="micro green mono"
            >● LIVE</text>

            <text
              x="873"
              y="47"
              class="micro muted mono"
            >PUBLIC</text>
          </g>

          <g transform="translate(54 97)">
            <text
              x="0"
              y="0"
              class="small green mono"
            >$ whoami</text>

            <g
              transform="translate(0 18)"
              clip-path="url(#nameReveal)"
            >
              <text
                x="0"
                y="34"
                class="hero bright mono"
              >{esc(name)}</text>
            </g>

            <text
              x="0"
              y="74"
              class="body cyan mono"
              opacity="0"
            >
              @{esc(USERNAME)}
              <animate
                attributeName="opacity"
                from="0"
                to="1"
                begin="0.9s"
                dur="0.35s"
                fill="freeze"
              />
            </text>

            <g
              transform="translate(0 86)"
              clip-path="url(#tagReveal)"
            >
              <text
                x="0"
                y="24"
                class="body text mono"
              >{esc(tagline)}</text>
            </g>

            <text
              x="0"
              y="132"
              class="small muted mono"
              opacity="0"
            >
              {esc(meta)}
              <animate
                attributeName="opacity"
                from="0"
                to="1"
                begin="1.35s"
                dur="0.45s"
                fill="freeze"
              />
            </text>

            <text
              x="0"
              y="154"
              class="small violet mono"
              opacity="0"
            >
              ↗ {esc(web_line)}
              <animate
                attributeName="opacity"
                from="0"
                to="1"
                begin="1.55s"
                dur="0.45s"
                fill="freeze"
              />
            </text>

            <g
              transform="translate(0 178)"
              opacity="0"
            >
              <animate
                attributeName="opacity"
                from="0"
                to="1"
                begin="1.7s"
                dur="0.5s"
                fill="freeze"
              />

              <rect
                x="0"
                y="0"
                width="142"
                height="44"
                rx="9"
                fill="#0c1726"
                stroke="#26364d"
              />

              <text
                x="13"
                y="17"
                class="micro muted mono"
              >PUBLIC REPOS</text>

              <text
                x="13"
                y="35"
                class="metric bright mono"
              >{fmt_int(public_repos)}</text>

              <rect
                x="154"
                y="0"
                width="142"
                height="44"
                rx="9"
                fill="#0c1726"
                stroke="#26364d"
              />

              <text
                x="167"
                y="17"
                class="micro muted mono"
              >FOLLOWERS</text>

              <text
                x="167"
                y="35"
                class="metric bright mono"
              >{fmt_int(followers)}</text>

              <rect
                x="308"
                y="0"
                width="142"
                height="44"
                rx="9"
                fill="#0c1726"
                stroke="#26364d"
              />

              <text
                x="321"
                y="17"
                class="micro muted mono"
              >FOLLOWING</text>

              <text
                x="321"
                y="35"
                class="metric bright mono"
              >{fmt_int(following)}</text>
            </g>
          </g>

          <g>
            <rect
              x="716"
              y="90"
              width="190"
              height="188"
              rx="18"
              fill="#09111e"
              stroke="#273853"
            />

            <circle
              cx="811"
              cy="174"
              r="69"
              fill="none"
              stroke="#22d3ee"
              stroke-width="1"
              opacity="0.16"
              stroke-dasharray="4 9"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 811 174"
                to="360 811 174"
                dur="18s"
                repeatCount="indefinite"
              />
            </circle>

            <circle
              cx="811"
              cy="174"
              r="58"
              fill="none"
              stroke="#a78bfa"
              stroke-width="1"
              opacity="0.18"
              stroke-dasharray="2 8"
            >
              <animate
                attributeName="stroke-dashoffset"
                from="0"
                to="-40"
                dur="7s"
                repeatCount="indefinite"
              />
            </circle>

            {identicon(USERNAME, 750, 111)}

            <text
              x="811"
              y="258"
              text-anchor="middle"
              class="micro muted mono"
            >fingerprint::{ident_hash}</text>
          </g>

          <line
            x1="54"
            y1="323"
            x2="906"
            y2="323"
            stroke="#243249"
            stroke-width="1"
          />

          <text
            x="54"
            y="350"
            class="small green mono"
          >$ git log --graph --since=1y</text>

          <text
            x="906"
            y="350"
            text-anchor="end"
            class="micro muted mono"
          >53W CONTRIBUTION SIGNAL</text>

          {''.join(month_labels)}

          <text
            x="36"
            y="406"
            text-anchor="middle"
            class="micro muted mono"
          >M</text>

          <text
            x="36"
            y="430"
            text-anchor="middle"
            class="micro muted mono"
          >W</text>

          <text
            x="36"
            y="454"
            text-anchor="middle"
            class="micro muted mono"
          >F</text>

          {''.join(heatmap_parts)}

          <g
            transform="translate(715 382)"
            opacity="0"
          >
            <animate
              attributeName="opacity"
              from="0"
              to="1"
              begin="2.25s"
              dur="0.6s"
              fill="freeze"
            />

            <rect
              x="0"
              y="0"
              width="192"
              height="116"
              rx="13"
              fill="#0b1422"
              stroke="#26364d"
            />

            <text
              x="14"
              y="19"
              class="micro muted mono"
            >CONTRIBUTIONS</text>

            <text
              x="14"
              y="45"
              class="metric bright mono"
            >{fmt_int(s['total'])}</text>

            <text
              x="14"
              y="70"
              class="micro muted mono"
            >CURRENT STREAK</text>

            <text
              x="178"
              y="70"
              text-anchor="end"
              class="small green mono"
            >{s['current']}d</text>

            <text
              x="14"
              y="89"
              class="micro muted mono"
            >LONGEST STREAK</text>

            <text
              x="178"
              y="89"
              text-anchor="end"
              class="small cyan mono"
            >{s['longest']}d</text>

            <text
              x="14"
              y="108"
              class="micro muted mono"
            >ACTIVE DAYS</text>

            <text
              x="178"
              y="108"
              text-anchor="end"
              class="small violet mono"
            >{s['active']}</text>
          </g>

          <g opacity="0">
            <animate
              attributeName="opacity"
              from="0"
              to="1"
              begin="2.65s"
              dur="0.55s"
              fill="freeze"
            />

            <text
              x="55"
              y="508"
              class="micro muted mono"
            >LESS</text>

            {''.join(
                f'<rect '
                f'x="{91 + i * 15}" '
                f'y="499" '
                f'width="9" '
                f'height="9" '
                f'rx="2" '
                f'fill="{palette[i]}"/>'
                for i in range(6)
            )}

            <text
              x="183"
              y="508"
              class="micro muted mono"
            >MORE</text>

            <text
              x="906"
              y="508"
              text-anchor="end"
              class="micro muted mono"
            >BEST {esc(s['best_day'].strftime('%b %d'))} · {s['best_count']} contribs</text>
          </g>

          <line
            x1="54"
            y1="532"
            x2="906"
            y2="532"
            stroke="#243249"
            stroke-width="1"
          />

          <text
            x="54"
            y="557"
            class="small green mono"
          >$ ./velocity --months 12</text>

          <text
            x="906"
            y="557"
            text-anchor="end"
            class="micro muted mono"
          >MONTHLY CONTRIBUTION VOLUME</text>

          {''.join(month_bars)}

          <g opacity="0">
            <animate
              attributeName="opacity"
              from="0"
              to="1"
              begin="3.05s"
              dur="0.55s"
              fill="freeze"
            />

            <text
              x="54"
              y="655"
              class="micro muted mono"
            >NO JS · NO THIRD-PARTY STATS · SELF-HOSTED SVG</text>

            <text
              x="906"
              y="655"
              text-anchor="end"
              class="micro muted mono"
            >{esc(generated)}</text>
          </g>

          <rect
            x="16"
            y="-36"
            width="928"
            height="24"
            fill="#67e8f9"
            opacity="0.035"
            filter="url(#softGlow)"
          >
            <animate
              attributeName="y"
              from="-36"
              to="710"
              dur="7.5s"
              repeatCount="indefinite"
            />
          </rect>

          <rect
            x="54"
            y="668"
            width="8"
            height="13"
            rx="1.5"
            fill="#64ffda"
            filter="url(#tinyGlow)"
          >
            <animate
              attributeName="opacity"
              values="1;1;0;0;1"
              keyTimes="0;0.45;0.5;0.95;1"
              dur="1.05s"
              repeatCount="indefinite"
            />
          </rect>
          </svg>'''

          SVG_PATH.write_text(
              svg,
              encoding="utf-8",
          )

          marker_start = (
              "<!-- PROFILE-NEON:START -->"
          )

          marker_end = (
              "<!-- PROFILE-NEON:END -->"
          )

          profile_block = f'''
          {marker_start}
          <div align="center">
            <img src="./profile.svg" width="960" alt="Animated GitHub profile for @{USERNAME}" />
          </div>
          {marker_end}
          '''.strip()

          if README_PATH.exists():
              existing = README_PATH.read_text(
                  encoding="utf-8"
              )

              if (
                  marker_start in existing
                  and marker_end in existing
              ):
                  pattern = re.compile(
                      re.escape(marker_start)
                      + r".*?"
                      + re.escape(marker_end),
                      re.DOTALL,
                  )

                  updated = pattern.sub(
                      profile_block,
                      existing,
                      count=1,
                  )

              else:
                  updated = (
                      profile_block
                      + "\n\n"
                      + existing.lstrip()
                  )

          else:
              updated = (
                  profile_block
                  + "\n"
              )

          README_PATH.write_text(
              updated,
              encoding="utf-8",
          )

          print(
              f"Rendered {SVG_PATH} for @{USERNAME}: "
              f"{s['total']} contributions across "
              f"{s['active']} active days"
          )
          PY

      - name: Commit refreshed profile art
        shell: bash
        run: |
          if git diff --quiet -- README.md profile.svg; then
            exit 0
          fi

          git config \
            user.name \
            "github-actions[bot]"

          git config \
            user.email \
            "41898282+github-actions[bot]@users.noreply.github.com"

          git add \
            README.md \
            profile.svg

          git commit \
            -m "chore: refresh animated profile [skip ci]"

          git push
