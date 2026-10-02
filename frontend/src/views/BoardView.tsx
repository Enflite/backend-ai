/**
 * Board view — nested routes for the kanban board.
 *
 *   /board           → the six-column kanban board
 *   /board/task/:id  → redirects to the canonical task workspace (/tasks/:id)
 *
 * Form cards link to /forms/:id — the Form AI Agent view owns that detail.
 */
import { Route, Routes } from 'react-router-dom';
import BoardPage from '../board/BoardPage';
import TaskRedirect from '../tasks/TaskRedirect';

export default function BoardView() {
  return (
    <Routes>
      <Route index element={<BoardPage />} />
      <Route path="task/:id" element={<TaskRedirect />} />
    </Routes>
  );
}
