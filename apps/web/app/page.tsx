import { type AlarmInfo, PlantView } from "@/components/plant/PlantView";
import { MissingData } from "@/components/MissingData";
import { loadAlarms, loadManifest } from "@/lib/server/data";

export default function PlantPage() {
  const manifest = loadManifest();
  if (!manifest) {
    return <MissingData what="The replay data" file="results/replay/manifest.json" fix="python -m faultline.export_replay" />;
  }
  const alarmInfo: Record<string, AlarmInfo> = {};
  for (const alarm of loadAlarms()) {
    alarmInfo[alarm.id] = {
      top: (alarm.top_signals ?? []).slice(0, 3).map((s) => s.signal),
      sustained: alarm.during_sustained_load,
    };
  }
  return <PlantView manifest={manifest} alarmInfo={alarmInfo} />;
}
