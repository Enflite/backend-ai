/**
 * studio/views/NewAutomationView.tsx — the "New automation" route.
 *
 * The builder canvas lands in a later slice; this route exists so the
 * Automations list can point at it honestly. It says exactly that — no
 * fake builder, no simulated steps.
 */
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/primitives';
import StudioEmpty, { IconBolt, StudioEmptyIcon } from '../components/StudioEmpty';

export default function NewAutomationView() {
  return (
    <StudioEmpty
      icon={
        <StudioEmptyIcon>
          <IconBolt />
        </StudioEmptyIcon>
      }
      title="The automation builder is coming soon"
      description="This is where you'll assemble automations from the API action catalog — pick actions, wire their inputs, and set a schedule or trigger. The builder ships in the next slice; the catalog is already browsable under APIs."
      action={
        <Link to="/studio/apis">
          <Button variant="outline">Browse the action catalog</Button>
        </Link>
      }
    />
  );
}
