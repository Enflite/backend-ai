/**
 * studio/views/SettingsView.tsx — studio settings.
 *
 * Studio-level settings (defaults, guardrails) ship with the backend
 * slice; until then this is an honest placeholder rather than a form
 * bound to endpoints that don't exist.
 */
import StudioEmpty, { IconGear, StudioEmptyIcon } from '../components/StudioEmpty';

export default function SettingsView() {
  return (
    <StudioEmpty
      icon={
        <StudioEmptyIcon>
          <IconGear />
        </StudioEmptyIcon>
      }
      title="Studio settings are coming soon"
      description="Run defaults, execution guardrails, and notification settings for the studio will live here once the backend settings surface lands."
    />
  );
}
