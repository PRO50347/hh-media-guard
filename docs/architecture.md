# Architecture

Next.js supplies the UI and API. SQLite at `/config/media-guard.db` stores settings, scan results, fingerprints, audit events, and retry counters. The scan path is `validated mapped path → ffprobe JSON → language normalization → rules decision → history`. Scanner errors are returned as errors and cannot result in actions. Background full-library enumeration and Arr imports are extension points; v0.1 supports safe single-file/manual workflow and authenticated webhook intake.
