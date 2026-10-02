/**
 * tasks/TaskRedirect.tsx — forwards the superseded task-detail routes
 * (`/agents/tasks/:id`, `/board/task/:id`) to the canonical `/tasks/:id`
 * workspace, preserving the task id and any `?tab=` deep link.
 */
import { Navigate, useParams, useSearchParams } from 'react-router-dom';

export default function TaskRedirect() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const query = tab ? `?tab=${encodeURIComponent(tab)}` : '';
  return <Navigate to={`/tasks/${encodeURIComponent(id ?? '')}${query}`} replace />;
}
