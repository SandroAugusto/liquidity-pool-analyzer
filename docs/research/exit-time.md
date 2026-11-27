# Exit times on public prices

Acceptance criterion 2 of [ADR-0005](../adr/0005-rebalance-economics.md): do exit
times simulated on real price paths match the model's E[T] = hL² / σ² when σ is taken
from a recent window, and how much does the window's length matter? Data and caching
decisions are in [ADR-0006](../adr/0006-public-candles-for-research.md).

**Result, in short:** not met, and the reasons are partly identified.

- On hourly data, much of the apparent lateness of narrow ranges comes from checking
  the price only at hourly closes.
- What remains at ±1 % is not reproduced by a Gaussian walk with the same volatility,
  and is approached by paths that keep the actual sizes of moves (in random order or
  with random signs). How much of it is fat tails, volatility clustering or the
  direction of moves cannot be separated cleanly: the seed brackets overlap and the
  answer depends on how σ is estimated on the altered paths.
- At ±8 % the median is within the method's noise, but both tails are wider than the
  model's own world gives.
- Both trailing σ windows miss the next week's σ by a similar amount; the 7-day window
  overshoots after volatility rises and the 30-day window after it falls.
- 120 days of data are too short to separate these effects.
- As a forecast, the model's quantiles of T are miscalibrated out of sample; quantiles
  of T / E[T] measured on one side of a split in time, with E[T] from the geometric mean of the 7-day and
  30-day σ, are close to calibrated on the other side of the split at ±1 % to ±4 %.
- Fees are not part of this study.

## Method

- **Prices.** Coinbase Exchange public candles for BTC-USD and SOL-USD; the price is
  BTC-USD close / SOL-USD close, i.e. SOL per BTC (quote per base for a WBTC/SOL
  pool). Only times with a candle for both products are kept; nothing is filled in.
- **Positions.** Synthetic. One position per width is opened at the close of every
  candle that starts at 00:00 UTC (so at 01:00 on hourly data and 00:01 on minute data)
  and has enough history for σ, centred on that close, at log half-widths hL of
  0.01, 0.02, 0.04 and 0.08 (written ±1 % … ±8 %). Positions opened on consecutive days
  overlap in time, so they are **not independent**: no confidence intervals are
  reported, and differences of a few hundredths between medians are not meaningful.
- **Exit.** The first sample close at or beyond a bound.
- **σ, known at opening.** Either the sample standard deviation of the log returns
  of 31 daily closes (30 one-day returns) up to and including the opening one, all of
  which must be present, or
  that of all samples in the 7 days before opening, scaled by √(samples per day). Each
  estimator needs its own history, so the two open different sets of positions (for
  example 700 and 723 over two years); comparisons between them are not paired.
- **Model.** From the centre of a driftless Brownian motion, T / E[T] has the same
  distribution for every width and σ, with survival function
  S(c) = Σ 4(−1)ⁿ / ((2n+1)π) · exp(−(2n+1)² π² c / 8) and median 0.757
  (`src/math/exit-time.ts`). The tables compare the observed fraction exited by c · E[T]
  with 1 − S(c).
- **Censoring.** At each c, only positions watched for at least c · E[T] are counted,
  exited or not; n is shown in each cell. Cells with a small n (the 2 · E[T] column at
  ±8 % over 120 days) say little. Eligibility at long horizons also favours positions
  with a high σ (short E[T]): over 120 days, the ±8 % positions counted at 2 · E[T] had a
  higher median σ than all ±8 % positions, so those cells describe a more volatile
  subset.
- **Checks at closes only.** A price checked every Δt is seen to exit late. The
  continuity correction of Broadie, Glasserman and Kou (1997) widens the barrier by
  0.5826 · σ · √Δt; the "corrected" column uses that half-width in E[T]. A seeded Monte
  Carlo in `tests/math/exit-time.test.ts` checks it for the mean exit time. The
  correction is asymptotic in σ · √Δt / hL. On hourly data at ±1 % that ratio is about
  0.5 at a typical σ, so the corrected ±1 % hourly figures are rough; minute data
  (ratio below 0.1) is the better evidence there. The calibration columns are against
  the uncorrected E[T].

Reproduce with `pnpm exit-time-study --from … --to … [--step minute]` (run on
2026-11-26; candles can be revised, so a later run may differ slightly). A separate
check outside the repository (a Python script, not published) reproduced the medians
to two decimals; it is not evidence a reader can rerun.

## Two years, hourly closes (2024-11-01 to 2026-11-01)

17,510 hourly samples; 5 times dropped because one product had no candle, and 5 with
no candle for either.

### σ from the 30 daily closes before opening

| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model 0.757) | Same, E[T] corrected for checks at closes only | Exited by 0.25·E[T]: observed / model (positions watched that long) | Exited by 0.5·E[T]: observed / model (positions watched that long) | Exited by 1·E[T]: observed / model (positions watched that long) | Exited by 2·E[T]: observed / model (positions watched that long) |
| -------------- | --------: | ----------------: | ----------------------------------------: | ---------------------------------------------: | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------------: | ---------------------------------------------------------------: |
| ±1 %           |       700 |                 0 |                                      1.89 |                                           1.14 |                                               4.0 % / 9.1 % (n 700) |                                            11.0 % / 31.5 % (n 700) |                                          27.1 % / 62.9 % (n 700) |                                          52.5 % / 89.2 % (n 699) |
| ±2 %           |       700 |                 2 |                                      1.34 |                                           1.04 |                                               5.9 % / 9.1 % (n 700) |                                            18.7 % / 31.5 % (n 699) |                                          38.3 % / 62.9 % (n 698) |                                          66.2 % / 89.2 % (n 696) |
| ±4 %           |       700 |                11 |                                      1.03 |                                           0.89 |                                              10.0 % / 9.1 % (n 698) |                                            24.9 % / 31.5 % (n 696) |                                          49.3 % / 62.9 % (n 694) |                                          74.2 % / 89.2 % (n 689) |
| ±8 %           |       700 |                19 |                                      0.77 |                                           0.71 |                                              14.0 % / 9.1 % (n 694) |                                            34.7 % / 31.5 % (n 689) |                                          58.4 % / 62.9 % (n 685) |                                          80.6 % / 89.2 % (n 640) |

### σ from the 7 days of samples before opening

| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model 0.757) | Same, E[T] corrected for checks at closes only | Exited by 0.25·E[T]: observed / model (positions watched that long) | Exited by 0.5·E[T]: observed / model (positions watched that long) | Exited by 1·E[T]: observed / model (positions watched that long) | Exited by 2·E[T]: observed / model (positions watched that long) |
| -------------- | --------: | ----------------: | ----------------------------------------: | ---------------------------------------------: | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------------: | ---------------------------------------------------------------: |
| ±1 %           |       723 |                 0 |                                      1.87 |                                           1.11 |                                               3.3 % / 9.1 % (n 723) |                                            10.5 % / 31.5 % (n 723) |                                          28.4 % / 62.9 % (n 723) |                                          53.0 % / 89.2 % (n 723) |
| ±2 %           |       723 |                 2 |                                      1.30 |                                           1.01 |                                               5.9 % / 9.1 % (n 723) |                                            16.2 % / 31.5 % (n 723) |                                          37.8 % / 62.9 % (n 720) |                                          68.1 % / 89.2 % (n 718) |
| ±4 %           |       723 |                11 |                                      1.01 |                                           0.90 |                                               8.9 % / 9.1 % (n 720) |                                            23.8 % / 31.5 % (n 718) |                                          49.7 % / 62.9 % (n 716) |                                          75.6 % / 89.2 % (n 712) |
| ±8 %           |       723 |                19 |                                      0.74 |                                           0.69 |                                              12.6 % / 9.1 % (n 716) |                                            35.7 % / 31.5 % (n 712) |                                          62.1 % / 62.9 % (n 697) |                                          80.3 % / 89.2 % (n 646) |

## The same 120 days, hourly and minute closes (2026-07-04 to 2026-11-01)

The window is limited to 120 days by the volume of minute data. Each estimator needs
its history inside the window, so the 30-day one opens 90 positions and the 7-day one 113.

### Hourly closes

2,880 samples; none dropped or missing.

#### σ from the 30 daily closes before opening

| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model 0.757) | Same, E[T] corrected for checks at closes only | Exited by 0.25·E[T]: observed / model (positions watched that long) | Exited by 0.5·E[T]: observed / model (positions watched that long) | Exited by 1·E[T]: observed / model (positions watched that long) | Exited by 2·E[T]: observed / model (positions watched that long) |
| -------------- | --------: | ----------------: | ----------------------------------------: | ---------------------------------------------: | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------------: | ---------------------------------------------------------------: |
| ±1 %           |        90 |                 0 |                                      1.77 |                                           1.15 |                                               10.0 % / 9.1 % (n 90) |                                             15.6 % / 31.5 % (n 90) |                                           35.6 % / 62.9 % (n 90) |                                           55.1 % / 89.2 % (n 89) |
| ±2 %           |        90 |                 2 |                                      1.39 |                                           1.07 |                                               12.2 % / 9.1 % (n 90) |                                             21.3 % / 31.5 % (n 89) |                                           38.6 % / 62.9 % (n 88) |                                           64.0 % / 89.2 % (n 86) |
| ±4 %           |        90 |                11 |                                      0.87 |                                           0.79 |                                               17.0 % / 9.1 % (n 88) |                                             32.6 % / 31.5 % (n 86) |                                           51.2 % / 62.9 % (n 84) |                                           74.7 % / 89.2 % (n 79) |
| ±8 %           |        90 |                19 |                                      0.62 |                                           0.59 |                                               26.2 % / 9.1 % (n 84) |                                             40.5 % / 31.5 % (n 79) |                                           65.3 % / 62.9 % (n 75) |                                           90.9 % / 89.2 % (n 33) |

#### σ from the 7 days of samples before opening

| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model 0.757) | Same, E[T] corrected for checks at closes only | Exited by 0.25·E[T]: observed / model (positions watched that long) | Exited by 0.5·E[T]: observed / model (positions watched that long) | Exited by 1·E[T]: observed / model (positions watched that long) | Exited by 2·E[T]: observed / model (positions watched that long) |
| -------------- | --------: | ----------------: | ----------------------------------------: | ---------------------------------------------: | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------------: | ---------------------------------------------------------------: |
| ±1 %           |       113 |                 0 |                                      1.29 |                                           0.99 |                                               4.4 % / 9.1 % (n 113) |                                            15.9 % / 31.5 % (n 113) |                                          38.9 % / 62.9 % (n 113) |                                          62.8 % / 89.2 % (n 113) |
| ±2 %           |       113 |                 2 |                                      1.36 |                                           1.18 |                                               9.7 % / 9.1 % (n 113) |                                            17.7 % / 31.5 % (n 113) |                                          39.1 % / 62.9 % (n 110) |                                          63.0 % / 89.2 % (n 108) |
| ±4 %           |       113 |                11 |                                      1.00 |                                           0.92 |                                              11.8 % / 9.1 % (n 110) |                                            24.1 % / 31.5 % (n 108) |                                          50.0 % / 62.9 % (n 106) |                                          81.4 % / 89.2 % (n 102) |
| ±8 %           |       113 |                19 |                                      0.60 |                                           0.58 |                                              12.3 % / 9.1 % (n 106) |                                            44.1 % / 31.5 % (n 102) |                                           75.9 % / 62.9 % (n 87) |                                           82.1 % / 89.2 % (n 39) |

### Minute closes

172,790 samples; 9 times dropped because one product had no candle, and 1 with no
candle for either.

#### σ from the 30 daily closes before opening

| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model 0.757) | Same, E[T] corrected for checks at closes only | Exited by 0.25·E[T]: observed / model (positions watched that long) | Exited by 0.5·E[T]: observed / model (positions watched that long) | Exited by 1·E[T]: observed / model (positions watched that long) | Exited by 2·E[T]: observed / model (positions watched that long) |
| -------------- | --------: | ----------------: | ----------------------------------------: | ---------------------------------------------: | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------------: | ---------------------------------------------------------------: |
| ±1 %           |        90 |                 0 |                                      1.29 |                                           1.22 |                                               12.2 % / 9.1 % (n 90) |                                             22.2 % / 31.5 % (n 90) |                                           40.0 % / 62.9 % (n 90) |                                           67.4 % / 89.2 % (n 89) |
| ±2 %           |        90 |                 1 |                                      0.94 |                                           0.91 |                                               18.9 % / 9.1 % (n 90) |                                             27.0 % / 31.5 % (n 89) |                                           51.7 % / 62.9 % (n 87) |                                           75.0 % / 89.2 % (n 84) |
| ±4 %           |        90 |                 3 |                                      0.74 |                                           0.73 |                                               21.8 % / 9.1 % (n 87) |                                             32.1 % / 31.5 % (n 84) |                                           59.0 % / 62.9 % (n 83) |                                           77.9 % / 89.2 % (n 77) |
| ±8 %           |        90 |                19 |                                      0.63 |                                           0.62 |                                               31.3 % / 9.1 % (n 83) |                                             44.2 % / 31.5 % (n 77) |                                           72.2 % / 62.9 % (n 72) |                                           96.9 % / 89.2 % (n 32) |

#### σ from the 7 days of samples before opening

| Log half-width | Positions | Still open at end | Observed median of T / E[T] (model 0.757) | Same, E[T] corrected for checks at closes only | Exited by 0.25·E[T]: observed / model (positions watched that long) | Exited by 0.5·E[T]: observed / model (positions watched that long) | Exited by 1·E[T]: observed / model (positions watched that long) | Exited by 2·E[T]: observed / model (positions watched that long) |
| -------------- | --------: | ----------------: | ----------------------------------------: | ---------------------------------------------: | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ---------------------------------------------------------------: | ---------------------------------------------------------------: |
| ±1 %           |       113 |                 0 |                                      1.60 |                                           1.52 |                                               8.0 % / 9.1 % (n 113) |                                            16.8 % / 31.5 % (n 113) |                                          32.7 % / 62.9 % (n 113) |                                          61.1 % / 89.2 % (n 113) |
| ±2 %           |       113 |                 1 |                                      1.15 |                                           1.13 |                                              10.6 % / 9.1 % (n 113) |                                            20.4 % / 31.5 % (n 113) |                                          45.5 % / 62.9 % (n 112) |                                          66.4 % / 89.2 % (n 110) |
| ±4 %           |       113 |                 3 |                                      1.27 |                                           1.25 |                                              12.5 % / 9.1 % (n 112) |                                            22.7 % / 31.5 % (n 110) |                                          39.3 % / 62.9 % (n 107) |                                          67.3 % / 89.2 % (n 104) |
| ±8 %           |       113 |                19 |                                      0.77 |                                           0.76 |                                              12.1 % / 9.1 % (n 107) |                                            30.8 % / 31.5 % (n 104) |                                           64.5 % / 62.9 % (n 93) |                                           85.9 % / 89.2 % (n 71) |

## What the data shows

1. **Hourly checks explain much of the lateness of narrow ranges.** With the 30-day σ,
   over the same 120 days, the hourly medians are 1.77, 1.39, 0.87 and 0.62 from ±1 % to
   ±8 %, and the minute medians 1.29, 0.94, 0.74 and 0.63. Correcting the hourly figures
   for checks at closes gives 1.15, 1.07, 0.79 and 0.59: closer to minute from ±1 % to
   ±4 %, not equal, and rough at ±1 % (see Method); at ±8 % the correction is small and
   moves the figure slightly away from minute. With the 7-day σ the corrected hourly and the
   minute medians do not agree (0.99 against 1.60 at ±1 %); see point 4.
2. **What remains depends on width.** On minute data with the 30-day σ, medians fall
   from 1.29 at ±1 % to 0.63 at ±8 %; the model predicts 0.757 for all of them. Two
   years of hourly data, corrected, show the same order (1.14 to 0.71). A single σ that
   describes both a few hours (E[T] at ±1 %) and a few weeks (E[T] at ±8 %) does not
   fit this pair. The diagnostics below test why.
3. **At ±8 % over two years, both tails are wider than the model.** With the 30-day σ
   and the uncorrected E[T], 14.0 % of positions exited within 0.25 · E[T] (model
   9.1 %) and 19.4 % were still in range at 2 · E[T] (model 10.8 %); with the corrected
   E[T] the figures are 15.6 % and 17.5 % (diagnostics, point 5). Elsewhere the picture is mixed: at narrow widths the hourly tails are confounded
   with the checks at closes, and over 120 days the ±8 % cells rest on few positions.
4. **The σ window was not settled.** Over two years of hourly data, the 7-day and
   30-day estimators give medians within 0.04 of each other at every width. Over 120
   days the tables differ more, but there the two estimators open different positions
   (the 7-day one adds the first 23 days), so the tables do not compare them like for
   like. With that caveat, on minute data the 7-day estimator, built from minute
   returns, gives later exits at every width in these tables, which would fit bid-ask
   noise inflating σ. The paired comparison and the lag are in the diagnostics below.
5. **Results depend on the period.** At ±8 %, the corrected hourly median is 0.71 over
   two years and 0.59 over the last 120 days.

## Diagnostics: what explains the differences

`pnpm exit-time-diagnostics --from … --to … [--step minute] [--seeds N]`, same data,
40 seeds. Surrogates rebuild the path from the same log returns, altered:

- **signs randomised:** each return keeps its size and position in time and gets a
  random sign. Keeps volatility clustering (when large moves happen); removes
  autocorrelation of returns (mean reversion, trends) and drift;
- **returns shuffled:** the same returns in random order. Keeps their distribution
  (fat tails); removes clustering, autocorrelation and drift;
- **Gaussian walk:** normal returns with the same per-step standard deviation, the
  model's own world.

By default σ is re-estimated on each path from its own 30 daily closes ("own σ"):
the same estimator on every row, though not the same noise, since clustered paths
give noisier σ estimates. Sign-randomised paths keep the actual sizes of moves in
place, so they are also run with the σ the actual prices gave on each date ("actual
σ"). The two conventions differ in one respect that matters: the actual daily σ
includes the effect of returns that reverse within the day, which the sign-randomised
paths no longer have, so under "actual σ" those paths move more than their σ says.
Brackets are nearest-rank percentiles across seeds (with 40 seeds, the 10th–90th
percentile is the 5th and 37th value). They measure the method's noise, not
uncertainty about the market.

### Two years, hourly closes

#### Variance ratio by horizon (one step = 1 hour)

1 for a random walk; below 1 when moves partly reverse. The second row is the same statistic on 40 sign-randomised paths (no reversal, same clustering): median [5th–95th percentile, nearest rank]. An actual value inside that range is not distinguishable from no reversal.

| Path             |              4 h |              1 d |              3 d |              7 d |             14 d |
| ---------------- | ---------------: | ---------------: | ---------------: | ---------------: | ---------------: |
| Actual prices    |             0.91 |             0.87 |             0.80 |             0.76 |             0.69 |
| Signs randomised | 1.00 [0.95–1.06] | 0.98 [0.88–1.12] | 0.96 [0.82–1.21] | 0.95 [0.77–1.37] | 0.95 [0.69–1.55] |

Net log change over the period (drift, which randomising signs removes): 0.67.

#### Median T / E[T] on surrogate paths

E[T] corrected for checks at closes; σ from the 30 daily closes before opening, re-estimated on each path ("own σ"), or for sign-randomised paths, which keep the actual sizes of moves in place, also taken from the actual prices on the same date ("actual σ"). Model 0.757. For surrogates: median over 40 seeds, with the 10th–90th percentile of the seeds in brackets (nearest rank). Brackets measure the method's noise, not uncertainty about the market.

| Path                                           |             ±1 % |             ±2 % |             ±4 % |             ±8 % |
| ---------------------------------------------- | ---------------: | ---------------: | ---------------: | ---------------: |
| Actual prices                                  |             1.14 |             1.04 |             0.89 |             0.71 |
| Signs randomised (keeps clustering), own σ     | 1.15 [1.09–1.23] | 1.00 [0.94–1.07] | 0.90 [0.85–0.98] | 0.83 [0.74–0.93] |
| Signs randomised (keeps clustering), actual σ  | 1.10 [1.05–1.14] | 0.94 [0.90–0.99] | 0.83 [0.79–0.90] | 0.76 [0.68–0.85] |
| Returns shuffled (keeps fat tails only), own σ | 1.02 [0.94–1.10] | 0.88 [0.82–0.93] | 0.80 [0.76–0.88] | 0.80 [0.72–0.85] |
| Gaussian walk (the model), own σ               | 0.77 [0.69–0.83] | 0.75 [0.70–0.81] | 0.73 [0.70–0.79] | 0.74 [0.67–0.83] |

#### Tails at ±8 %

Share exited by 0.25 · E[T] and share still in range at 2 · E[T], E[T] corrected for checks at closes (model 9.1 % and 10.8 %). Surrogates: median [10th–90th percentile] over 40 seeds, own σ.

| Path             | Exited by 0.25 · E[T] | Still in range at 2 · E[T] |
| ---------------- | --------------------: | -------------------------: |
| Actual prices    |                15.6 % |                     17.5 % |
| Signs randomised |    12.9 [11.1–14.8] % |         17.8 [14.1–22.9] % |
| Returns shuffled |     10.7 [9.5–12.3] % |          13.3 [9.6–17.5] % |
| Gaussian walk    |     11.3 [9.6–12.3] % |          10.9 [8.2–14.9] % |

#### 7-day and 30-day σ on the same 700 opening dates

Median T / E[T], E[T] corrected for checks at closes.

| σ estimator       | ±1 % | ±2 % | ±4 % | ±8 % |
| ----------------- | ---: | ---: | ---: | ---: |
| 30 daily closes   | 1.14 | 1.04 | 0.89 | 0.71 |
| 7 days of samples | 1.12 | 1.02 | 0.90 | 0.69 |

#### Trailing σ against the σ of the next 7 days

All σ from the same one-step returns. Cells: median ln(forecast / realised) (> 0: too high), then root mean square, then days.

| Days                                   |     Trailing 7 days |   Trailing 30 days | Geometric mean of both |
| -------------------------------------- | ------------------: | -----------------: | ---------------------: |
| All days                               |  0.03, 0.34 (n 697) | 0.09, 0.33 (n 697) |     0.07, 0.31 (n 697) |
| After a rise (7-day σ > 1.25 × 30-day) |   0.37, 0.50 (n 73) |  0.06, 0.32 (n 73) |      0.20, 0.37 (n 73) |
| After a fall (7-day σ < 0.8 × 30-day)  | -0.12, 0.35 (n 187) | 0.26, 0.38 (n 187) |     0.07, 0.31 (n 187) |

### 120 days, minute closes

#### Variance ratio by horizon (one step = 1 minute)

1 for a random walk; below 1 when moves partly reverse. The second row is the same statistic on 40 sign-randomised paths (no reversal, same clustering): median [5th–95th percentile, nearest rank]. An actual value inside that range is not distinguishable from no reversal.

| Path             |            5 min |           15 min |              1 h |              4 h |              1 d |
| ---------------- | ---------------: | ---------------: | ---------------: | ---------------: | ---------------: |
| Actual prices    |             0.90 |             0.86 |             0.76 |             0.67 |             0.64 |
| Signs randomised | 1.00 [0.95–1.09] | 0.98 [0.92–1.13] | 0.96 [0.89–1.13] | 0.95 [0.82–1.18] | 0.94 [0.72–1.29] |

Net log change over the period (drift, which randomising signs removes): 0.07.

#### Median T / E[T] on surrogate paths

E[T] corrected for checks at closes; σ from the 30 daily closes before opening, re-estimated on each path ("own σ"), or for sign-randomised paths, which keep the actual sizes of moves in place, also taken from the actual prices on the same date ("actual σ"). Model 0.757. For surrogates: median over 40 seeds, with the 10th–90th percentile of the seeds in brackets (nearest rank). Brackets measure the method's noise, not uncertainty about the market.

| Path                                           |             ±1 % |             ±2 % |             ±4 % |             ±8 % |
| ---------------------------------------------- | ---------------: | ---------------: | ---------------: | ---------------: |
| Actual prices                                  |             1.22 |             0.91 |             0.73 |             0.62 |
| Signs randomised (keeps clustering), own σ     | 1.04 [0.76–1.38] | 0.86 [0.68–1.18] | 0.79 [0.59–0.98] | 0.65 [0.46–1.13] |
| Signs randomised (keeps clustering), actual σ  | 0.70 [0.60–0.83] | 0.63 [0.56–0.72] | 0.57 [0.48–0.77] | 0.49 [0.35–0.87] |
| Returns shuffled (keeps fat tails only), own σ | 0.79 [0.61–1.04] | 0.77 [0.66–0.95] | 0.77 [0.64–0.92] | 0.82 [0.55–1.26] |
| Gaussian walk (the model), own σ               | 0.77 [0.62–1.00] | 0.74 [0.62–0.90] | 0.77 [0.60–0.89] | 0.75 [0.53–1.01] |

#### Tails at ±8 %

Share exited by 0.25 · E[T] and share still in range at 2 · E[T], E[T] corrected for checks at closes (model 9.1 % and 10.8 %). Surrogates: median [10th–90th percentile] over 40 seeds, own σ.

| Path             | Exited by 0.25 · E[T] | Still in range at 2 · E[T] |
| ---------------- | --------------------: | -------------------------: |
| Actual prices    |                31.3 % |                      3.1 % |
| Signs randomised |    19.3 [12.9–26.4] % |          19.0 [2.6–56.5] % |
| Returns shuffled |     11.0 [4.8–18.8] % |          10.8 [0.0–34.8] % |
| Gaussian walk    |     11.6 [4.5–18.6] % |          10.6 [0.0–29.8] % |

#### 7-day and 30-day σ on the same 90 opening dates

Median T / E[T], E[T] corrected for checks at closes.

| σ estimator       | ±1 % | ±2 % | ±4 % | ±8 % |
| ----------------- | ---: | ---: | ---: | ---: |
| 30 daily closes   | 1.22 | 0.91 | 0.73 | 0.62 |
| 7 days of samples | 1.61 | 1.16 | 0.99 | 0.74 |

#### Trailing σ against the σ of the next 7 days

All σ from the same one-step returns. Cells: median ln(forecast / realised) (> 0: too high), then root mean square, then days.

| Days                                   |    Trailing 7 days |  Trailing 30 days | Geometric mean of both |
| -------------------------------------- | -----------------: | ----------------: | ---------------------: |
| All days                               |  0.06, 0.39 (n 86) | 0.16, 0.37 (n 86) |      0.11, 0.36 (n 86) |
| After a rise (7-day σ > 1.25 × 30-day) |   0.45, 0.52 (n 9) | -0.14, 0.43 (n 9) |       0.15, 0.40 (n 9) |
| After a fall (7-day σ < 0.8 × 30-day)  | -0.03, 0.15 (n 17) | 0.29, 0.29 (n 17) |      0.13, 0.16 (n 17) |

### What the diagnostics show

1. **At ±1 % the model's own world does not reproduce the lateness; the actual sizes
   of moves come close.** On two years of hourly data: actual 1.14; Gaussian walk 0.77
   (0.69–0.83); shuffled returns 1.02 (0.94–1.10); sign-randomised 1.15 (1.09–1.23)
   with their own σ and 1.10 (1.05–1.14) with the actual σ. The shuffled and
   sign-randomised brackets overlap, so fat tails and clustering are not separated,
   and the actual value is at the top of the sign-randomised bracket with the actual
   σ (inside it with their own σ), so a small contribution from direction is not
   ruled out. A likely mechanism, not tested
   directly: when much of the variance comes in rare large moves, most hours are
   calmer than the average σ implies, so a narrow range opened in a calm hour lasts
   far longer than E[T].
2. **At other widths and on minute data, direction matters, or the σ convention does.**
   At ±2 % (hourly) the sign-randomised paths with the actual σ give 0.94
   (0.90–0.99) against an actual 1.04; on minute data at ±1 % they give 0.70
   (0.60–0.83) against 1.22, while with their own σ they give 1.04 (0.76–1.38). Either
   the reversal of moves keeps narrow ranges alive, or the actual-σ convention
   understates how much those paths move (see above); these runs do not tell which.
3. **Mean reversion is clear at short horizons, marginal beyond.** Against
   sign-randomised paths (no reversal, same clustering), the hourly variance ratio is
   clearly below the 5th percentile at 4 h (0.91 against 0.95) and just below it at
   1 d to 7 d (0.87 against 0.88, 0.80 against 0.82, 0.76 against 0.77); at 14 d it is
   at the 5th percentile (0.69). With 40 seeds the 5th percentile is the 3rd-lowest
   value, so only the 4 h result is firm. On minute data it is clearly below at every
   horizon from 5 minutes to 1 day; at the shortest horizons bid-ask bounce may
   contribute (not tested).
4. **At ±8 % the median is within the method's noise.** The Gaussian walk gives 0.74
   (0.67–0.83), a range that holds both the model's 0.757 and the actual 0.71. The
   actual value is below the sign-randomised paths with their own σ (0.83, 0.74–0.93)
   but inside them with the actual σ (0.76, 0.68–0.85), so that gap depends on the σ
   convention. The price moved by 0.67 in log terms over the two years; drift, which
   sign randomisation removes, is not tested.
5. **At ±8 % both tails are wider than the method's noise.** 15.6 % of positions
   exited within 0.25 · E[T], above every surrogate's bracket (Gaussian walk 11.3 %,
   9.6–12.3 %; sign-randomised 12.9 %, 11.1–14.8 %). 17.5 % were still in range at
   2 · E[T], above the Gaussian walk (10.9 %, 8.2–14.9 %) and matched by sign-randomised
   paths (17.8 %, 14.1–22.9 %), but also at the edge of shuffled ones (13.3 %,
   9.6–17.5 %): consistent with clustering, not proof of it. What produces the extra
   early exits is not identified.
6. **On the same opening dates, the two windows give the same medians on hourly
   data** (within 0.02 over 700 dates). On minute data the 7-day estimator, built from
   minute returns, gives later exits on the same 90 dates (1.61 against 1.22 at
   ±1 %), consistent with bid-ask noise inflating minute σ (not tested).
7. **Lag, quantified.** This table uses one-step (hourly) returns for every window, so
   its 30-day σ is 30 days of hourly returns, not the 30 daily closes used for E[T]
   elsewhere; with a 1-day variance ratio of 0.87 the two differ by about 7 %. As
   forecasts of the σ realised over the next 7 days, both windows have a root mean
   square log error of about 0.33: a factor of about 1.4 either way in σ (+39 % or
   −28 %), and so about 1.9 either way in E[T]. After volatility rises (7-day σ above
   1.25 times the 30-day), the 7-day window overshoots by a median of 0.37 in log terms
   (+45 %) while the 30-day is nearly unbiased; after it falls (below 0.8 times), the
   30-day window overshoots by 0.26 (+30 %) and the 7-day undershoots by 0.12. Part of
   the 7-day overshoot is probably regression to the mean of a noisy estimate, since
   the regimes are defined by that estimate (not tested). Overall, the geometric mean
   of the two has the lowest error (0.31 against 0.34 and 0.33) and the smallest swing
   between the two situations, but after a rise the 30-day window alone does better
   (0.32 against 0.37). Forward windows overlap, so the 73 and 187 days are far fewer
   independent observations; no uncertainty is attached to these differences.
8. **120 days is too short.** On minute data the Gaussian walk's ±1 % median has a
   10th–90th percentile of 0.62–1.00 across seeds, wider than most of the effects in
   this report. Points 1, 4 and 5 rest on the two years of hourly data; the minute
   results in points 2, 3 and 6 are indicative only.

## Forecasting time in range

`pnpm exit-time-forecast --from 2024-11-01 --to 2026-11-01 --split 2025-11-01 --boot 200`.
If E[T] is not a reliable forecast, what is? Each method predicts the 10th, 50th and
90th percentiles of T for a new position as q · E[T]:

- **Model:** q from the driftless walk (0.757 for the median), E[T] from the 30-day σ;
- **Empirical:** q measured on earlier positions of the same width (fixed-horizon
  counting, as in the calibration tables), E[T] from the 30-day σ;
- **Empirical by regime:** the same, measured separately in each tercile of 7-day σ
  over 30-day σ at opening;
- **Empirical, blended σ:** q measured per width, with E[T] from the geometric mean of
  the 7-day and 30-day σ.

Every E[T] is corrected for checks at closes. Methods are fitted on one side of the split and tested
on the other, in both directions, with 30 days before the split left out. On this data
every position on the earlier side had exited before the later side began (checked;
the code does not enforce it, so wider ranges or a shorter embargo would need the check
again). A forecast is calibrated when, in each
volatility regime, 10 %, 50 % and 90 % of the test positions have exited by its 10th,
50th and 90th percentiles; the score is the mean distance from those targets. The
brackets are 10th–90th percentiles (an 80 % band) from resampling test days in 30-day
blocks, with every method scored on the same resamples.

#### Train on positions opened before 2025-10-02, test from 2025-11-01

305 training and 365 test opening days. Regime terciles of 7-day σ / 30-day σ, cut on the training days: below 0.87, 0.87–1.15, above 1.15.

Mean |coverage − target| over the three regimes and the 10th, 50th and 90th percentiles (0 is calibrated). In brackets: 10th–90th percentile of the difference from the baseline (Empirical, 30-day σ) over 200 paired block-bootstrap resamples of the test days (30-day blocks); a bracket entirely below 0 means better than the baseline on these resamples.

| Method                        |                     ±1 % |                     ±2 % |                     ±4 % |                     ±8 % |
| ----------------------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: |
| Model, 30-day σ               | 0.128 [+0.033 to +0.062] | 0.139 [+0.038 to +0.064] | 0.110 [+0.006 to +0.036] | 0.117 [+0.003 to +0.031] |
| Empirical, 30-day σ           |         0.079 (baseline) |         0.077 (baseline) |         0.081 (baseline) |         0.096 (baseline) |
| Empirical by regime, 30-day σ | 0.058 [-0.039 to -0.001] | 0.071 [-0.026 to +0.006] | 0.058 [-0.032 to +0.009] | 0.077 [-0.035 to -0.002] |
| Empirical, blended σ          | 0.031 [-0.055 to -0.021] | 0.050 [-0.036 to -0.013] | 0.064 [-0.031 to +0.009] | 0.066 [-0.043 to -0.002] |

Coverage of the predicted 10th / 50th / 90th percentiles of T, all regimes together (targets 0.1 / 0.5 / 0.9).

| Method                        |               ±1 % |               ±2 % |               ±4 % |               ±8 % |
| ----------------------------- | -----------------: | -----------------: | -----------------: | -----------------: |
| Model, 30-day σ               | 0.08 / 0.35 / 0.75 | 0.10 / 0.37 / 0.78 | 0.13 / 0.44 / 0.81 | 0.18 / 0.53 / 0.79 |
| Empirical, 30-day σ           | 0.10 / 0.49 / 0.90 | 0.11 / 0.51 / 0.92 | 0.12 / 0.49 / 0.92 | 0.11 / 0.53 / 0.79 |
| Empirical by regime, 30-day σ | 0.10 / 0.51 / 0.89 | 0.10 / 0.49 / 0.87 | 0.15 / 0.47 / 0.93 | 0.12 / 0.53 / 0.81 |
| Empirical, blended σ          | 0.10 / 0.51 / 0.89 | 0.10 / 0.52 / 0.92 | 0.14 / 0.48 / 0.93 | 0.11 / 0.51 / 0.82 |

#### Train on positions opened from 2025-11-01, test before 2025-10-02

365 training and 305 test opening days. Regime terciles of 7-day σ / 30-day σ, cut on the training days: below 0.90, 0.90–1.09, above 1.09.

Mean |coverage − target| over the three regimes and the 10th, 50th and 90th percentiles (0 is calibrated). In brackets: 10th–90th percentile of the difference from the baseline (Empirical, 30-day σ) over 200 paired block-bootstrap resamples of the test days (30-day blocks); a bracket entirely below 0 means better than the baseline on these resamples.

| Method                        |                     ±1 % |                     ±2 % |                     ±4 % |                     ±8 % |
| ----------------------------- | -----------------------: | -----------------------: | -----------------------: | -----------------------: |
| Model, 30-day σ               | 0.092 [+0.032 to +0.063] | 0.076 [+0.005 to +0.032] | 0.073 [+0.004 to +0.027] | 0.045 [-0.036 to -0.003] |
| Empirical, 30-day σ           |         0.046 (baseline) |         0.061 (baseline) |         0.058 (baseline) |         0.082 (baseline) |
| Empirical by regime, 30-day σ | 0.033 [-0.027 to +0.013] | 0.079 [-0.008 to +0.041] | 0.080 [-0.013 to +0.058] | 0.094 [-0.019 to +0.043] |
| Empirical, blended σ          | 0.020 [-0.032 to -0.002] | 0.034 [-0.037 to -0.001] | 0.030 [-0.040 to +0.008] | 0.058 [-0.038 to +0.003] |

Coverage of the predicted 10th / 50th / 90th percentiles of T, all regimes together (targets 0.1 / 0.5 / 0.9).

| Method                        |               ±1 % |               ±2 % |               ±4 % |               ±8 % |
| ----------------------------- | -----------------: | -----------------: | -----------------: | -----------------: |
| Model, 30-day σ               | 0.08 / 0.36 / 0.77 | 0.09 / 0.38 / 0.79 | 0.11 / 0.45 / 0.80 | 0.15 / 0.50 / 0.90 |
| Empirical, 30-day σ           | 0.10 / 0.52 / 0.90 | 0.10 / 0.50 / 0.89 | 0.06 / 0.53 / 0.87 | 0.09 / 0.42 / 0.97 |
| Empirical by regime, 30-day σ | 0.09 / 0.49 / 0.89 | 0.11 / 0.50 / 0.86 | 0.08 / 0.52 / 0.85 | 0.10 / 0.53 / 0.92 |
| Empirical, blended σ          | 0.10 / 0.50 / 0.91 | 0.11 / 0.49 / 0.89 | 0.07 / 0.51 / 0.89 | 0.11 / 0.50 / 0.96 |

### What the forecasts show

1. **The model's quantiles are miscalibrated out of sample.** At ±1 % in both
   directions, only 35–36 % of positions had exited by the model's median and 75–77 %
   by its 90th percentile. Its score is worse than the empirical baseline at ±1 % to
   ±4 % in both directions (brackets above 0). At ±8 % it is worse in one direction and
   better in the other.
2. **Quantiles measured on one side of the split are close to calibrated on the other at ±1 % to
   ±4 %.** All regimes together, the empirical methods' coverage is within 0.05 of the
   10 / 50 / 90 % targets at those widths in both directions. At ±8 % the 90th
   percentile misses in both directions (0.79 to 0.82 in one, 0.92 to 0.97 in the
   other), and with the 30-day σ the reverse median is 0.42.
3. **The blended σ helps at narrow widths; regime buckets do not reliably.** With E[T]
   from the blended σ, the score is better than the baseline at ±1 % and ±2 % in both
   directions, firmly when training on the first year and borderline the other way
   (the 80 % bands end at −0.002 and −0.001); at ±4 % and ±8 % it is better in one case
   and not distinguishable in the other three. Measuring quantiles per regime is better
   than the baseline at two of four widths when training on the first year and not
   distinguishable elsewhere.
4. **Limits.** One pair, one venue, two years split in two. Positions overlap within
   each year, which the block bootstrap only partly accounts for; regimes are cut on
   the training year. The forecast is for centred positions and says nothing about
   fees.

## Not covered

- **Fees.** Criterion 1 of ADR-0005 (fees in range proportional to σ / hL). This
  report assumed it needs liquidity by tick over time; it does not, because a centred
  position's fees while in range follow from the pool's cumulative fee growth alone.
  Hourly snapshots of the public pools are collected from 2026-11-27
  ([ADR-0007](../adr/0007-fee-growth-snapshots.md)); the study waits for enough data.
- **Drift and positions opened away from the centre.** All positions are centred.
- **Other pairs and venues.** One pair, one venue's candles.

## Is the Coinbase cross price the pool's price?

Every figure above is measured on Coinbase BTC-USD / SOL-USD, not on an Orca pool. A
position lives in one pool, whose price is moved by swaps and arbitrage, so the two can
differ, and most at short intervals: the ±1 % results, where the model misses most,
are also where a difference between venues would matter most.

`pnpm proxy-basis <snapshots.jsonl …>` compares each pool's price in the fee snapshots
([ADR-0007](../adr/0007-fee-growth-snapshots.md)) with the Coinbase cross price of the
last minute that ended before the snapshot (`src/research/proxy-basis.ts`). Two
quantities, kept apart:

- the **level** of the basis, ln(pool / Coinbase). A constant offset does not change
  exit times, since a position is centred on its own pool's price;
- its **change** between consecutive snapshots of a pool, next to Coinbase's own log
  return over the same interval. That is what the Coinbase path misses about the
  pool's path, and what could bias exit times measured on it.

**First reading, one snapshot (2026-11-27 18:10 UTC):**

- The deepest pool (0.05 % fee tier, liquidity about 7.8 · 10³ in model units, three
  orders of magnitude above the next one) was 13.7 bp above Coinbase. Part of that is
  the up-to-a-minute lag between the Coinbase close and the snapshot.
- The thin pools of the same pair ranged from 8 to 198 bp above Coinbase.
- Three pools had no active liquidity; their prices (461 to 764 SOL per WBTC against
  about 833) are what the last swap left behind, and are skipped.

So at this one reading the deep pool tracks Coinbase to well under the ±1 % half-width,
and "the pool's price" is not one number: thin pools of the same pair can sit
200 bp away. One snapshot says nothing about the change in basis, which is the
quantity that matters for exit times; that needs weeks of hourly snapshots. Until then
the results above describe the Coinbase cross price, and transfer to a pool only
to the extent that its basis is stable.
