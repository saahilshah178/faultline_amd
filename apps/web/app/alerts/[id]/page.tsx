import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlertView } from "@/components/alert/AlertView";
import { listAlertIds, loadAlert, loadChunks, loadManifest, loadSources } from "@/lib/server/data";
import type { Excerpt } from "@/lib/types";

export const dynamicParams = false;

export function generateStaticParams() {
  return listAlertIds().map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Alert ${id}` };
}

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const alert = loadAlert(id);
  if (!alert) notFound();

  // Cached chat answers cite manual chunks by id; pass along the ones the page will need to show.
  const have = new Set((alert.retrieval?.excerpts ?? []).map((e) => e.id));
  const wanted = new Set((alert.chat_examples ?? []).flatMap((qa) => (qa.citations ?? []).flatMap((c) => c.chunk_ids ?? [])));
  const extra: Excerpt[] = [...wanted].some((cid) => !have.has(cid))
    ? (loadChunks() ?? []).filter((c) => wanted.has(c.id) && !have.has(c.id))
    : [];

  const ids = listAlertIds();
  const index = ids.indexOf(id);
  return (
    <AlertView
      alert={alert}
      signals={loadManifest()?.signals ?? []}
      sources={loadSources()}
      extraExcerpts={extra}
      prev={index > 0 ? ids[index - 1] : null}
      next={index >= 0 && index < ids.length - 1 ? ids[index + 1] : null}
    />
  );
}
