/**
 * FormsView — SyteLine Form AI Agent view: nested routes inside the app
 * shell at /forms.
 *
 *   /forms        history list + "New customization"
 *   /forms/new    the submission form
 *   /forms/:id    one customization's detail + pipeline progress
 */
import { Route, Routes } from "react-router-dom"
import FormsHistory from "../components/formAgent/FormsHistory"
import NewCustomizationForm from "../components/formAgent/NewCustomizationForm"
import CustomizationDetail from "../components/formAgent/CustomizationDetail"

export default function FormsView() {
  return (
    <Routes>
      <Route index element={<FormsHistory />} />
      <Route path="new" element={<NewCustomizationForm />} />
      <Route path=":id" element={<CustomizationDetail />} />
    </Routes>
  )
}
