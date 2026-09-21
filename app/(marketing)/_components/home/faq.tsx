import { ChevronDown } from "lucide-react";
import { Section, SectionHeading } from "../section";
import { CtaLink } from "../cta-button";

const FAQS: { question: string; answer: string }[] = [
  {
    question: "What exactly do you build?",
    answer:
      "A connected system covering lead capture, instant response, qualification, follow-up, appointment and estimate tracking, reactivation, reviews and referrals, and reporting — built around Trackpr and managed by us.",
  },
  {
    question: "Do I need to replace my CRM?",
    answer:
      "Not necessarily. The system is built to work with your existing setup where it makes sense. The right architecture depends on your business, and that's something we work through with you before anything is built.",
  },
  {
    question: "Do I need a new website?",
    answer:
      "No. We can build a new lead-capture-focused website where it helps, but the system can also plug into your current one — the priority is making sure inquiries get captured and followed up on, not replacing what already works.",
  },
  {
    question: "What happens when a lead comes in?",
    answer:
      "It gets captured, gets a fast response, and moves through qualification and follow-up automatically — instead of sitting in a voicemail, a missed text, or an inbox until someone has time.",
  },
  {
    question: "Can this work with missed calls?",
    answer: "Yes — missed calls are one of the most common leaks the system is built to close.",
  },
  {
    question: "Does this replace my office staff?",
    answer:
      "No. It's built to support the people already answering calls and following up, not replace them — handling the repetitive follow-through so nothing falls through the cracks.",
  },
  {
    question: "How long does setup take?",
    answer:
      "It depends on the size of your business and what's already in place. We start with an audit of how leads currently move through your process, then build from there.",
  },
  {
    question: "Who manages the system?",
    answer: "We do. It's not handed to you to configure and maintain — Contractor Growth Co. builds it, connects it, and manages it on an ongoing basis.",
  },
  {
    question: "What happens after launch?",
    answer: "The system is monitored and refined on an ongoing basis as your business and lead volume change — it isn't a one-time setup we walk away from.",
  },
  {
    question: "Do I need to learn new software?",
    answer:
      "You'll have visibility into what's happening, but you're not expected to learn or configure a new platform. That's the part we handle.",
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
        <CtaLink href="/signup" variant="secondary">
          Get Started
        </CtaLink>
      </div>
    </Section>
  );
}
