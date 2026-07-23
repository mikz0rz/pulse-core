export function SectionBlock({ title, content }: { title: string; content: string }) {
  return (
    <div className="section-block">
      <h3 className="section-block__headline">{title}</h3>
      <p className="section-block__summary">{content}</p>
    </div>
  );
}
