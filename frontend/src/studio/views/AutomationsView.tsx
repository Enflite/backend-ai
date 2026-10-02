/**
 * studio/views/AutomationsView.tsx — the automation library.
 *
 * The automations list endpoint lands with the backend builder slice, so
 * until then this is the honest empty state: no invented automations,
 * just the inviting slot and the New Automation affordance.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { hasAnyPermission } from '../../shell/navRegistry';
import { Button } from '../../components/ui/primitives';
import StudioEmpty, { IconBolt, StudioEmptyIcon } from '../components/StudioEmpty';
import { STUDIO_MANAGE_PERMISSIONS } from '../types';

export default function AutomationsView() {
  const { user } = useAuth();
  const canCreate = hasAnyPermission(user?.permissions ?? [], STUDIO_MANAGE_PERMISSIONS);

  return (
    <StudioEmpty
      icon={
        <StudioEmptyIcon>
          <IconBolt />
        </StudioEmptyIcon>
      }
      title="No automations yet"
      description="Automations are repeatable workflows you build from the API action catalog — triggered on a schedule, a webhook, or on demand. Create your first one to get started."
      action={
        canCreate ? (
          <Link to="/studio/automations/new">
            <Button variant="primary">New Automation</Button>
          </Link>
        ) : undefined
      }
    />
  );
}
