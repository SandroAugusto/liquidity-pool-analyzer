# Exit times on public prices

Acceptance criterion 2 of [ADR-0005](../adr/0005-rebalance-economics.md): do exit
times simulated on real price paths match the model's E[T] = hL² / σ² when σ is taken
from a recent window, and how much does the window's length matter? Data and caching
decisions are in [ADR-0006](../adr/0006-public-candles-for-research.md).

**Result, in short:** not met. On hourly data, much of the apparent lateness of narrow
ranges comes from checking the price only at hourly closes. Minute data, where that
effect is small, still shows narrow ranges (±1 %, ±2 %) exiting later than the model at
the median; with the 30-day σ, wide ranges (±8 %) exit early (corrected hourly and minute medians 6 to 22 % below the model; with the 7-day
σ on minute data, on time). At ±8 % over two years, both tails
are wider than the model. The lag of a trailing σ window was not measured. Fees are not
part of this study.

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
   fit this pair. Hypotheses, **not tested here**: most hours are quieter than the daily
   σ implies and moves come in bursts (volatility intermittency); the ratio
   mean-reverts at short horizons and trends at longer ones; or drift over the weeks a
   wide range lives. Noise in the σ estimate alone would widen both tails but not, by
   itself, order the medians by width. Evidence that would separate them: the variance
   of returns over 1 h, 4 h, 1 d and 7 d on the same data, exit times conditioned on
   realised volatility over the life of the position, and drift over the same windows;
   no single one of these settles it.
3. **At ±8 % over two years, both tails are wider than the model.** With the 30-day σ,
   14.0 % of positions exited within 0.25 · E[T] (model 9.1 %) and 19.4 % were still in
   range at 2 · E[T] (model 10.8 %); the correction for hourly checks is small at this
   width. Elsewhere the picture is mixed: at narrow widths the hourly tails are confounded
   with the checks at closes, and over 120 days the ±8 % cells rest on few positions.
4. **The σ window was not settled.** Over two years of hourly data, the 7-day and
   30-day estimators give medians within 0.04 of each other at every width. Over 120
   days the tables differ more, but there the two estimators open different positions
   (the 7-day one adds the first 23 days), so the tables do not compare them like for
   like. With that caveat, on minute data the 7-day estimator, built from minute
   returns, gives later exits at every width in these tables, which would fit bid-ask
   noise inflating σ; neither a paired comparison nor that explanation is tested here. ADR-0005 expected a
   long trailing window to lag behind the regime; this study did not measure lag (that
   would need exit times conditioned on a change in regime), so criterion 2's "lag
   quantified" remains open.
5. **Results depend on the period.** At ±8 %, the corrected hourly median is 0.71 over
   two years and 0.59 over the last 120 days.

## Not covered

- **Fees.** Criterion 1 of ADR-0005 (fees in range proportional to σ / hL) needs pool
  volume and liquidity by tick over time; that is not studied here.
- **The lag of a trailing σ window**, see point 4.
- **Drift and positions opened away from the centre.** All positions are centred.
- **Other pairs and venues.** One pair, one venue's candles; a pool's own price can
  differ from a centralised exchange's, most of all over short intervals.
