// An honest empty state: says which pipeline file is missing and what writes it.
export function MissingData({ what, file, fix, why }: { what: string; file: string; fix?: string; why?: string }) {
  return (
    <div className="panel empty-state" data-testid="missing-data">
      <h2>{what} is not available yet</h2>
      <p>
        This view only shows what the pipeline wrote. <code>{file}</code> does not exist in the data this build was made from.
        {why ? ` ${why}` : ""}
      </p>
      {fix ? (
        <p>
          It is written by <code>{fix}</code>. Run that, then rebuild the app.
        </p>
      ) : null}
    </div>
  );
}
