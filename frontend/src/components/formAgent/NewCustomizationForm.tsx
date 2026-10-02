/**
 * formAgent/NewCustomizationForm.tsx — the "new customization" submission
 * form for the SyteLine Form AI Agent.
 *
 * Five inputs: form .XML, IDO properties CSV, SQL Tables columns CSV,
 * an instruction list (one per line), and optional attachments — plus a
 * form name, title, and an optional requester name.
 *
 * Client validation runs through formAgent/payload.validateNewCustomization
 * (the backend re-validates; this only catches obvious mistakes early).
 * 202 accepted -> navigates to the new detail view. FEATURE_DISABLED maps
 * to DisabledState, other 403s to NotAuthorizedState, and VALIDATION_ERROR
 * surfaces inline.
 */
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { createFormCustomization } from "../../api/formAgent"
import { ApiError } from "../../api"
import { DisabledState, NotAuthorizedState } from "../ui/ErrorState"
import Spinner from "../ui/Spinner"
import {
  buildCreateFormData,
  emptyValues,
  parseInstructions,
  validateNewCustomization,
  type NewCustomizationValues,
} from "../../formAgent/payload"
import {
  classifyFormAgentError,
  formAgentErrorMessage,
} from "../../formAgent/errors"

const INPUT_CLASS =
  "w-full text-sm px-3 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
const INPUT_STYLE: React.CSSProperties = {
  background: "var(--background)",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
}
const LABEL_CLASS = "block text-sm font-medium mb-1"
const LABEL_STYLE: React.CSSProperties = { color: "var(--foreground)" }
const HINT_CLASS = "text-xs mt-1"
const HINT_STYLE: React.CSSProperties = { color: "var(--muted-foreground)" }

function fileOf(input: HTMLInputElement): File | null {
  return input.files && input.files.length > 0 ? input.files[0] as File : null
}

/** Assign each validation message to the input it belongs to (best effort). */
function fieldErrorsFor(errors: string[]): Record<string, string[]> {
  const byField: Record<string, string[]> = {}
  const assign = (field: string, message: string) => {
    byField[field] = byField[field] ?? []
    byField[field]!.push(message)
  }
  for (const message of errors) {
    if (/form name/i.test(message)) assign("formName", message)
    else if (/^title is required/i.test(message)) assign("title", message)
    else if (/instruction/i.test(message)) assign("instructionsText", message)
    else if (/form xml/i.test(message)) assign("formXml", message)
    else if (/ido properties/i.test(message))
      assign("idoPropertiesCsv", message)
    else if (/sql columns/i.test(message)) assign("sqlColumnsCsv", message)
    else assign("general", message)
  }
  return byField
}

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages || messages.length === 0) return null
  return (
    <div className="text-xs mt-1 space-y-0.5" style={{ color: "#a50a24" }}>
      {messages.map((message, i) => (
        <p key={i}>{message}</p>
      ))}
    </div>
  )
}

function FileInput({
  id,
  label,
  hint,
  accept,
  onChange,
  errorMessages,
}: {
  id: string
  label: string
  hint: string
  accept: string
  onChange: (file: File | null) => void
  errorMessages?: string[]
}) {
  const [fileName, setFileName] = useState<string | null>(null)
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS} style={LABEL_STYLE}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <label
          htmlFor={id}
          className="text-sm px-3 py-2 rounded-md cursor-pointer"
          style={{
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
        >
          Choose file
        </label>
        <span
          className="text-sm truncate"
          style={{
            color: fileName ? "var(--foreground)" : "var(--muted-foreground)",
          }}
        >
          {fileName ?? "No file chosen"}
        </span>
      </div>
      <input
        id={id}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = fileOf(e.target)
          setFileName(file ? file.name : null)
          onChange(file)
        }}
      />
      <p className={HINT_CLASS} style={HINT_STYLE}>
        {hint}
      </p>
      <FieldError messages={errorMessages} />
    </div>
  )
}

export default function NewCustomizationForm() {
  const navigate = useNavigate()
  const [values, setValues] = useState<NewCustomizationValues>(emptyValues())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [apiProblem, setApiProblem] = useState<"disabled" | "forbidden" | null>(
    null,
  )

  const set = <K extends keyof NewCustomizationValues,>(
    key: K,
    value: NewCustomizationValues[K],
  ) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errors = validateNewCustomization(values)
    setFieldErrors(fieldErrorsFor(errors))
    setSubmitError(null)
    if (errors.length > 0) return

    setSubmitting(true)
    try {
      const accepted = await createFormCustomization(
        buildCreateFormData(values),
      )
      navigate(`/forms/${accepted.id}`, { replace: true })
    } catch (err) {
      const problem = classifyFormAgentError(err)
      if (problem === "disabled") {
        setApiProblem("disabled")
      } else if (problem === "forbidden") {
        setApiProblem("forbidden")
      } else {
        // VALIDATION_ERROR (backend-side checks) or anything unexpected:
        // surface it inline so the requester can fix and retry.
        setSubmitError(
          err instanceof ApiError &&
            err.code === "VALIDATION_ERROR" &&
            err.message
            ? err.message
            : formAgentErrorMessage(err),
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (apiProblem === "disabled") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <DisabledState
          product="Form AI Agent"
          hint="The Form AI Agent is switched off on the backend (FORM_CUSTOMIZATION_API_ENABLED=false). An administrator needs to enable it before customizations can be submitted."
        />
      </div>
    )
  }
  if (apiProblem === "forbidden") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <NotAuthorizedState product="the SyteLine Form AI Agent" />
      </div>
    )
  }

  const instructionCount = parseInstructions(values.instructionsText).length

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl">
        <h1
          className="text-lg font-semibold"
          style={{ color: "var(--foreground)" }}
        >
          New form customization
        </h1>
        <p
          className="text-sm mt-1 mb-6"
          style={{ color: "var(--muted-foreground)" }}
        >
          Describe the customization and attach the five inputs. The agent
          builds the form from the TRN original, verifies the result, and opens
          a review PR for a human to merge.
        </p>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
          <div>
            <label
              htmlFor="formName"
              className={LABEL_CLASS}
              style={LABEL_STYLE}
            >
              Form name
            </label>
            <input
              id="formName"
              type="text"
              className={INPUT_CLASS}
              style={INPUT_STYLE}
              placeholder="PurchaseOrderDetailReportViewer"
              value={values.formName}
              onChange={(e) => set("formName", e.target.value)}
              disabled={submitting}
            />
            <p className={HINT_CLASS} style={HINT_STYLE}>
              The SyteLine form name — letters, digits, and underscores only.
            </p>
            <FieldError messages={fieldErrors.formName} />
          </div>

          <div>
            <label htmlFor="title" className={LABEL_CLASS} style={LABEL_STYLE}>
              Title
            </label>
            <input
              id="title"
              type="text"
              className={INPUT_CLASS}
              style={INPUT_STYLE}
              placeholder="Re-point the collection and add a terms-and-conditions footer"
              value={values.title}
              onChange={(e) => set("title", e.target.value)}
              disabled={submitting}
            />
            <p className={HINT_CLASS} style={HINT_STYLE}>
              Used for the FormSync project and the review PR title.
            </p>
            <FieldError messages={fieldErrors.title} />
          </div>

          <div>
            <label
              htmlFor="requestedBy"
              className={LABEL_CLASS}
              style={LABEL_STYLE}
            >
              Requested by{" "}
              <span style={{ color: "var(--muted-foreground)" }}>
                (optional)
              </span>
            </label>
            <input
              id="requestedBy"
              type="text"
              className={INPUT_CLASS}
              style={INPUT_STYLE}
              placeholder="Your name"
              value={values.requestedBy}
              onChange={(e) => set("requestedBy", e.target.value)}
              disabled={submitting}
            />
          </div>

          <div>
            <label
              htmlFor="instructions"
              className={LABEL_CLASS}
              style={LABEL_STYLE}
            >
              Instructions
            </label>
            <textarea
              id="instructions"
              rows={6}
              className={INPUT_CLASS}
              style={{ ...INPUT_STYLE, resize: "vertical" }}
              placeholder={
                "One instruction per line:\nRe-point the collection to the new SQL table\nAdd a terms-and-conditions footer"
              }
              value={values.instructionsText}
              onChange={(e) => set("instructionsText", e.target.value)}
              disabled={submitting}
            />
            <p className={HINT_CLASS} style={HINT_STYLE}>
              One instruction per line
              {instructionCount > 0 ? ` — ${instructionCount} so far` : ""}.
            </p>
            <FieldError messages={fieldErrors.instructionsText} />
          </div>

          <FileInput
            id="formXml"
            label="Current form .XML"
            hint="The FormSync export of the current form definition."
            accept=".xml"
            onChange={(file) => set("formXml", file)}
            errorMessages={fieldErrors.formXml}
          />

          <FileInput
            id="idoPropertiesCsv"
            label="IDO properties CSV"
            hint="The IDO properties the form relies on."
            accept=".csv"
            onChange={(file) => set("idoPropertiesCsv", file)}
            errorMessages={fieldErrors.idoPropertiesCsv}
          />

          <FileInput
            id="sqlColumnsCsv"
            label="SQL Tables columns CSV"
            hint="The SQL Tables column list behind the form."
            accept=".csv"
            onChange={(file) => set("sqlColumnsCsv", file)}
            errorMessages={fieldErrors.sqlColumnsCsv}
          />

          <div>
            <label
              htmlFor="attachments"
              className={LABEL_CLASS}
              style={LABEL_STYLE}
            >
              Attachments{" "}
              <span style={{ color: "var(--muted-foreground)" }}>
                (optional)
              </span>
            </label>
            <input
              id="attachments"
              type="file"
              multiple
              className="text-sm"
              style={{ color: "var(--foreground)" }}
              disabled={submitting}
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : []
                set("attachments", files)
              }}
            />
            <p className={HINT_CLASS} style={HINT_STYLE}>
              Mockups, notes, screenshots — anything the agent should see (up to
              20 files).
            </p>
            <FieldError messages={fieldErrors.attachments} />
            {values.attachments.length > 0 && (
              <ul
                className="text-xs mt-2 space-y-0.5"
                style={{ color: "var(--muted-foreground)" }}
              >
                {values.attachments.map((file) => (
                  <li key={file.name}>• {file.name}</li>
                ))}
              </ul>
            )}
          </div>

          {submitError && (
            <div
              className="rounded-lg p-4 text-sm"
              style={{
                background: "#fee2e2",
                border: "1px solid #fecaca",
                color: "#a50a24",
              }}
            >
              <p className="font-medium">Couldn't submit the request</p>
              <p className="mt-1">{submitError}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="text-sm font-medium px-4 py-2 rounded-md disabled:opacity-60 inline-flex items-center gap-2"
              style={{
                background: "var(--accent)",
                color: "var(--accent-foreground)",
              }}
            >
              {submitting && <Spinner size={14} />}
              {submitting ? "Submitting…" : "Submit to the Form AI Agent"}
            </button>
            <button
              type="button"
              onClick={() => navigate("/forms")}
              className="text-sm px-4 py-2 rounded-md"
              style={{
                border: "1px solid var(--border)",
                color: "var(--foreground)",
              }}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
