# Recorded retention evidence

The ML folder is the first two complete occurrences of the actual Limen
5.29.0 run `storage_preflight_20261017_lgbm_tail_h24/20261017_084929/s1`.
CSV rows and decompressed round records are unchanged; gzip framing is new.
Metadata, manifest and the referenced market blob are copied verbatim.

`btc_spot_hourly.parquet` is the original BTC spot hourly input snapshot:
SHA-256 `a8e482179a7bf2b0a2a1d006a25298618e5a89cf501304baa0dac956211d01c4`.
The image proof uses this recorded market and the first recorded parameter
point to produce fresh control evidence in the tested native environment.
Native Limen writes all evidence, CSV, metadata and checkpoints itself.
No analytical results or log fields are fabricated.
