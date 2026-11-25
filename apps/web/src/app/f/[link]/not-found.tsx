import "@/features/forms/form-runner.css";

export default function FormNotFound() {
  return (
    <div className="hf">
      <main className="hf-main" style={{ paddingTop: 72 }}>
        <section className="hf-card hf-done">
          <h1>This form link isn&apos;t active</h1>
          <p>
            Check the link for a typo, or ask the agency that sent it for a new one.
          </p>
        </section>
      </main>
    </div>
  );
}
