# Faultline

Predictive-maintenance copilot for an industrial air compressor, built for the
AMD Developer Hackathon: ACT III (Intelligent Industry track).

Faultline replays real sensor data from the MetroPT-3 dataset (the air production
unit of a Porto metro train, Feb-Aug 2020, with four real air-leak failures),
raises alarms before failures with an anomaly detector trained on an AMD Instinct
MI300X, and for each alarm has an open LLM served by vLLM on the same MI300X
explain the likely cause, citing a maintenance manual, and draft a technician
work order.

Work in progress. Full README lands with the submission kit.

## License

MIT. See [LICENSE](LICENSE).
