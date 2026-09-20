import { ChevronDown } from "lucide-react";
import { Section, SectionHeading } from "../section";
import { CtaLink } from "../cta-button";

const FAQS: { question: string; answer: string }[] = [
  {
    question: "Is this a CRM?",
    answer:
      "Trackpr powers the system, but Contractor Growth Co. is a managed growth service. We build and manage the system around your business rather than simply handing you software.",
  },
  {
    question: "Do I need to replace my current CRM?",
    answer:
      "The system is built to integrate with your existing setup where appropriate. The exact architecture depends on your business — that's something we work through with you.",
  },
  {
    question: "Do I need a new website?",
    answer:
      "Contractor Growth Co. can build the website and lead-capture layer where needed, but the system can also focus purely on lead management depending on your business.",
  },
  {
    question: "Does AI talk to my customers?",
    answer:
      "AI-assisted communication is used within defined safety boundaries and appropriate workflows. Situations that require human judgment are routed to you.",
  },
  {
    question: "Will you manage it for me?",
    answer: "Yes. The service is designed to be built and managed for you, not simply handed over.",
  },
  {
    question: "Who is this for?",
    answer: "Contractors and service businesses that want a more systematic process for handling opportunities and customers.",
  },
  {
    question: "Can I see the system?",
    answer: "Yes — the fastest way is to get started below and we'll walk you through it.",
  },
];

export function Faq() {
  return (
    <Section tone="subtle">
      <SectionHeading eyebrow="Questions" title="Frequently Asked Questions." align="center" />

      <div className="mx-auto mt-12 max-w-2xl divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
        {FAQS.map((faq) => (
          <details key={faq.question} className="group px-6 py-5 first:rounded-t-2xl last:rounded-b-2xl">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium text-slate-900 marker:content-none">
              {faq.question}
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{faq.answer}</p>
          </details>
        ))}
      </div>

      <div className="mt-10 text-center">
        <CtaLink href="/get-started" variant="secondary">
          Get Started / Demo
        </CtaLink>
      </div>
    </Section>
  );
}
