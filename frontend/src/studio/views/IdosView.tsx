/**
 * studio/views/IdosView.tsx — the IDO metadata browser.
 *
 * The studio contract exposes no IDO endpoint yet, so this view shows
 * exactly what the upstream exposes: nothing. No IDO names or fields are
 * invented here — those arrive with the backend's IDO probe slice.
 */
import StudioEmpty, { IconTable, StudioEmptyIcon } from '../components/StudioEmpty';

export default function IdosView() {
  return (
    <StudioEmpty
      icon={
        <StudioEmptyIcon>
          <IconTable />
        </StudioEmptyIcon>
      }
      title="IDO metadata not available for this connection"
      description="The IDO browser shows the objects and fields each connected tenant actually exposes — but the studio backend's IDO probe isn't live yet. Once it is, this view lists real IDOs per connection, nothing invented."
    />
  );
}
