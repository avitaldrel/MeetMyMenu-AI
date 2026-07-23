# The New Front Door: How People Find Restaurants in the Age of AI Search

*A research summary on restaurant discovery, generative AI, voice, and accessibility*
*Prepared for Meet My Menu | July 2026*

---

## Abstract

Finding a restaurant now takes several small decisions instead of one search. You hear about a place through social media, an AI answer, a friend, or a delivery app. You verify it through Google Maps, reviews, menus, and photos. Then you get directions, reserve, or order. Google starts more of these journeys than anything else, and it no longer finishes them alone.

The clearest new signal: about one in five U.S. adults has used generative AI to choose a restaurant. Two independent 2026-era surveys put the figure at 20 to 22 percent, rising above 60 percent among 25 to 34 year olds. AI's real weight runs larger than that number, because AI now sits inside Google, Yelp, Maps, and delivery apps, compressing a list of hundreds of restaurants down to a handful of recommendations.

That compression drives everything else. A conventional engine ranks every option and shows dozens. An AI engine returns three, five, or ten. A restaurant left out of the answer is invisible, and audits suggest a large share of real restaurants are already missing. The restaurants that get chosen have information that is structured, consistent, recent, and machine-readable.

For a voice-first, accessibility-focused product, these forces point the same way. The structured, spoken-friendly menu data that lets a blind guest navigate a menu is the same data an AI engine needs to recommend the restaurant.

---

## Key findings at a glance

| Finding | Figure | Source quality |
|---|---:|---|
| U.S. diners who discover restaurants online | **94%** | Strong (SevenRooms) |
| Consumers who research restaurants via Google | **56%** | Strong (Reputation/Nielsen) |
| Consumers who have used AI to choose a restaurant (2026) | **22%** | Strong (DoorDash/Dynata, n=3,001) |
| Consumers who used AI to research restaurants/bars (2025) | **20%** | Strong (Reputation/Nielsen) |
| Ages 25–34 using AI for food/drink recommendations | **61%** | Strong (Reputation) |
| Americans who read reviews for local businesses | **97%** | Strong (BrightLocal) |
| Searches that end without a click (zero-click) | **~65%** | Directional (aggregated 2026 SEO data) |
| Zero-click rate when a Google AI Overview appears | **~83%** | Directional |
| Restaurant locations absent from AI recommendations (QSR audit) | **83%** | Directional (Uberall, sponsored) |
| Restaurants never recommended in constrained academic audit | **47.5%** | Strong-method preprint (arXiv) |
| Diners who use voice search to find a restaurant | **~50%** | Directional (recycled industry stats) |
| Annual U.S. disability-community restaurant spending | **~$35B** | Directional (advocacy/industry) |
| Dining establishments not catering to visually impaired guests | **~75%** | Directional (industry) |

*These come from different surveys with different samples and years. You cannot add them together. People use several channels in one decision. Where a number reads "directional," treat it as a signal of direction and rough scale, not a precise measurement.*

---

## 1. Discovery runs in four stages

**Stage one, the idea.** A restaurant enters your mind through a Google or Maps search, a friend, an Instagram or TikTok post, an AI recommendation, a review site, a delivery app, or a local guide. SevenRooms found 94 percent of U.S. diners use online resources to discover new places. Offline discovery has become the exception.

**Stage two, the shortlist.** AI, social video, Maps, list articles, and delivery apps shape this stage most. A conventional engine returns links and a map. An AI system reads the requirements in a question like *"a cheap Italian place near me with vegetarian options, parking, and a quiet room"* and returns one short synthesized answer. Delivery apps do the same work: DoorDash reports 55 percent of first-time orders came from people browsing, not searching a specific restaurant.

**Stage three, validation.** After discovery, you want proof. You check the rating and recent reviews, the menu and prices, food and room photos, hours and parking, dietary and accessibility information, and whether the details agree across sites. BrightLocal found 97 percent of Americans read reviews for local businesses, the average person consults six review platforms, and 74 percent value reviews from the last three months. Reputation found nearly 40 percent look at an online menu before visiting.

**Stage four, the transaction.** The final action often lands somewhere other than where discovery began: Maps for directions, the website for the menu, OpenTable or Resy or Yelp for a booking, DoorDash or Uber Eats for delivery, a phone call, or a walk-in. Most transactions involve familiar restaurants (DoorDash: about 80 percent of dine-in visits are repeat places), so discovery matters most for winning the first visit. After that, food, service, and loyalty take over.

---

## 2. How big is AI restaurant discovery?

The two strongest restaurant-specific U.S. studies land on nearly the same number:

- **Reputation/Nielsen (2025):** 20 percent used AI to research restaurants or bars.
- **DoorDash/Dynata (2026):** 22 percent have used AI to help choose a restaurant.

So the safe headline: about one in five U.S. consumers has used generative AI to select a restaurant. That counts people who have ever done it, not one in five meals or searches.

The average hides a generational split. AI food-and-drink recommendation use runs at 61 percent for ages 25 to 34 and 4 percent for those over 65. "Used AI" also differs from "AI is my default." One multinational survey found 15 percent name an AI chatbot as their primary discovery method while 43 percent would use AI to match specific criteria. Today most people reach for occasional assistance. Younger cohorts point toward AI as a default.

---

## 3. Most AI restaurant discovery hides inside Google

Counting only people who open ChatGPT undercounts AI's footprint. You now meet AI through Google AI Overviews and AI Mode, Yelp's assistant and review summaries, DoorDash's conversational search, Maps summaries, and social recommendation algorithms. Many of these people will tell you they used Google.

Zero-click search shows the effect. Across 2026 industry data, about 65 percent of searches end without a click, climbing to about 83 percent when an AI Overview appears. Google has signaled it will extend AI Overviews further into local and transactional queries through 2026 and 2027. The answer becomes the destination, and the restaurant either appears in that answer or nobody sees it.

Read the "one in five" figure as the visible floor of AI's influence, not the ceiling.

---

## 4. The gatekeeper problem: ranking versus selecting

A conventional engine ranks. It shows dozens of restaurants, a map, ads, and pages of links, and a mediocre listing still surfaces on page two. An AI engine returns three, five, or ten names, and everything else drops out of view. Omission hurts more than a low rank, because the diner never learns the excluded restaurant exists.

Two studies with different methods both found large-scale invisibility:

- A **Uberall** QSR benchmark reported 83 percent of restaurant locations absent from AI recommendations even though 86 percent had a Google presence. (Sponsored, directional.)
- An **academic preprint** audited three model families across 304 neighborhoods in five cities. When the researchers constrained the models to verified restaurants, 47.5 percent were never recommended, and about a third of those blind spots repeated across all three model families. (Stronger method.)

The audit's mechanism matters. Restaurants with more reviews and more evidence of real-world activity showed up more. Thinly documented restaurants got ignored, confused with another business, or hallucinated. An AI engine needs enough corroborating evidence to answer with confidence. That disadvantages new, small, independent restaurants, and any restaurant whose menu exists only as an image or an inaccessible PDF.

---

## 5. Voice is a parallel front door, and it rewards the same signals

Voice earns its own section because it runs large and lines up with a voice-first product. Industry estimates (recycled across marketing sources, so directional) put about half of diners using voice search to find restaurant information, with food service the largest local voice-search category and billions of voice-enabled devices in use. Siri, Alexa, and Google Assistant do not read ten blue links aloud. They return one answer, drawn from Google Business Profile data and structured schema.

Voice sharpens the same gatekeeper dynamic as generative text search: one spoken answer, no scrolling. It rewards the same asset, clean structured data. Optimize a restaurant to be spoken and you optimize it to be recommended.

---

## 6. The accessibility market is a discovery market

The disability community stays underserved and spends real money. Industry and advocacy figures (directional) put the disability community's total spending power near $1 trillion, with about $35 billion a year spent in U.S. restaurants, and about three quarters of disabled people dining out at least weekly. About 75 percent of dining establishments still do not cater to visually impaired guests, and menus rank among the core failure points.

Two facts make this a strategy, not a nicety:

1. **The community talks.** Advocacy groups and assistive-technology forums carry word of mouth fast. A genuinely accessible restaurant earns loyal, repeat customers who recommend it to others.
2. **The accessible artifact and the discoverable artifact match.** A menu a screen reader or voice assistant can read (category, item, description, price, dietary tag) gives an AI engine the same structured, machine-readable data it cites when it recommends a restaurant. Accessibility work builds discovery infrastructure.

---

## 7. The GEO playbook: what determines whether a restaurant appears

Generative Engine Optimization (GEO) covers the work of making a restaurant recommendable by AI. Pulling together the audits and practitioner guidance, five requirements stand out, in rough priority order:

1. **Consistent identity everywhere.** Name, address, phone, hours, cuisine, and website should match across the website, Google Business Profile, Apple Maps, Bing, Yelp, delivery apps, reservations, and social. An AI engine reads agreement across sources as a trust signal, and consumers already check for it.
2. **A readable, complete HTML menu, not a PDF.** Practitioners state it bluntly: replace PDF menus with structured HTML carrying category, item, description, price, ingredients where feasible, and allergen or dietary labels as selectable, indexable text. Image-only or PDF-only menus stay invisible to search engines, AI, and screen readers.
3. **Schema markup.** Restaurant and FAQ schema translate the page into machine-readable structure. Marked-up content shows up in AI answers more often, and AI engines lean on FAQPage schema to extract direct answers about a location.
4. **Review volume, recency, and specificity.** A high rating helps, and an AI engine also needs enough recent, detailed reviews to establish what a place is known for. Nearly half of consumers avoid businesses with fewer than 20 reviews.
5. **Intent-matching detail.** Communicate more than "great food": good for families or dates or groups, quiet or lively, outdoor seating, parking and transit, price range, vegan, kosher, halal, gluten-free, allergy handling, and wheelchair and visual accessibility. These specifics let an AI engine answer specific questions instead of only generic ones.

Different AI engines cite different sources. Large-scale citation analyses show some lean on first-party websites, others on listings, reviews, or local press, so no single page guarantees visibility everywhere. Consistency across the whole footprint is the robust play.

---

## 8. Does AI raise restaurant revenue?

Overclaiming comes easy here, so hold the line.

Well established: digital reputation moves revenue. Harvard Business School research (Luca) used Yelp's rating-rounding thresholds and estimated a one-star increase drove a 5 to 9 percent revenue lift for independent restaurants, with near-zero effect for chains. Algorithmic personalization also changes choices: an iFood production experiment that changed which restaurants it showed lifted conversion. DoorDash reports restaurants with photos on a majority of menu items saw about a 13 percent sales lift (platform-reported association, not a controlled trial).

Not established: no strong, independent national study proves "being recommended by ChatGPT raises annual sales by X percent." Attribution breaks the chain. A diner discovers a place in an AI answer, searches it in Maps, reads the menu, and walks in. The trail looks like a direct or Maps visit, never an AI referral.

The defensible conclusion: AI changes visibility and shortlists, digital reputation and algorithmic ranking change revenue, and the precise revenue tied to generative AI is still emerging. Do not quote it as a hard number.

---

## 9. What this means for Meet My Menu

The research supports a value proposition wider than "put a menu online." A structured, accessible menu does four jobs at once:

1. **Accessibility.** Blind and low-vision guests, and voice-assistant users, can navigate it.
2. **Conversion.** Diners inspect dishes, prices, and dietary details before visiting.
3. **Traditional search visibility.** Engines index individual dishes, cuisine terms, and location.
4. **AI and voice discoverability.** AI engines and voice assistants get the corroborating evidence they need to recommend the restaurant.

The strongest claim the evidence supports:

> An accessible, structured, machine-readable menu helps more people understand a restaurant, and gives search engines, voice assistants, and AI systems the information they need to recommend it, as discovery consolidates into a handful of spoken or summarized answers.

Skip any fixed revenue promise ("increase revenue by 10 percent"). The evidence runs strong on discoverability, information quality, accessibility, and reduced decision friction, and stays thin on precise AI-driven revenue.

---

## Methodology and a note on source quality

This summary draws on two tiers of evidence. Keep the tiers separate:

- **Strong sources** are large, named consumer surveys and peer-reviewable work: DoorDash/Dynata (n=3,001), Reputation/Nielsen, BrightLocal, SevenRooms, TouchBistro, the Harvard Business School Yelp study, and the arXiv audit of LLM restaurant recommendations across five cities. Figures from these read as measurements.
- **Directional sources** are vendor-sponsored benchmarks (e.g. Uberall), aggregated SEO-industry statistics (zero-click, "near me," and voice-search figures that recycle across marketing blogs), and disability-market spending estimates from advocacy and trade sources. These indicate direction and rough scale, not precise values, and carry the "directional" label above.

Percentages come from different samples and different years and do not sum. Where the original 2026 briefing this builds on documented a figure, it stays. New material here covers voice search, the accessibility market, the GEO tactical playbook, and zero-click mechanics.

---

## Sources

**Restaurant-specific consumer surveys**
- DoorDash, *Restaurant Industry Trends Report 2026* — https://about.doordash.com/en-us/news/doordash-restaurant-industry-trends-report-2026
- DoorDash Merchants, *2026 restaurant delivery trends* — https://merchants.doordash.com/en-us/restaurant-industry-trends
- Reputation, *New Survey on AI and Dining Out in America* — https://reputation.com/resources/press/new-reputation-survey-reveals-how-ai-and-economic-pressures-are-rewriting-the-rules-of-dining-out-in-america
- SevenRooms, *2025 US Data Report* — https://sevenrooms.com/press/2025-US-data-report/
- TouchBistro, *Diner Trends Report* — https://www.touchbistro.com/blog/diner-trends-report/

**Search behavior, reviews, and AI trust**
- BrightLocal, *Consumer Search Behavior* — https://www.brightlocal.com/research/consumer-search-behavior/
- BrightLocal, *Local Consumer Review Survey 2026* — https://www.brightlocal.com/research/local-consumer-review-survey/
- BrightLocal, *AI Trust in Business Recommendations* — https://www.brightlocal.com/research/lcrs-ai-trust/
- Rio SEO, *2025 Local Search Consumer Behavior Study* — https://www.rioseo.com/resources/white-paper/2025-local-search-consumer-behavior-study/

**AI visibility, citations, and audits**
- Uberall, *2026 GEO Playbook for Multi-Location QSRs* — https://uberall.com/en-us/qsr-geo-playbook-2026
- arXiv, *Large language models create an uneven informational layer over cities* — https://arxiv.org/abs/2607.06260
- Yext, *AI Citation Behavior Across Models (17.2M citations)* — https://www.yext.com/research/ai-citation-behavior-across-models
- arXiv, *Personalized Recommendation of Dish and Restaurant Collections on iFood* — https://arxiv.org/abs/2508.03670
- AP News, *Yelp introduces an AI chatbot* — https://apnews.com/article/c43a6a642c9f649e1707ba29d52a143c

**GEO, schema, and structured data (added research)**
- Marqii, *GEO 101: Generative Engine Optimization for Restaurants* — https://blog.marqii.com/geo-101-a-guide-for-restaurants/
- Malou, *Structured data for restaurants: the complete 2026 guide* — https://www.malou.io/en-us/blog/structured-data-for-restaurants
- Hustle Marketers, *Restaurant Schema Markup: Complete 2026 Guide* — https://hustlemarketers.com/restaurant-schema-markup/

**Zero-click and AI Overviews (added research, directional)**
- SEO Inc., *AI and SEO in 2026: Zero-Click Search, AI Overviews and GEO* — https://www.seoinc.com/seo-blog/ai-and-seo-2026/
- DigitalApplied, *Zero-Click Search Statistics 2026* — https://www.digitalapplied.com/blog/zero-click-search-statistics-2026-complete-data

**Voice search (added research, directional)**
- Invoca, *40+ Voice Search Stats for 2026* — https://www.invoca.com/blog/voice-search-stats-marketers
- Synup, *80+ Industry-Specific Voice Search Statistics for 2026* — https://www.synup.com/en/voice-search-statistics
- BizIQ, *Local Search Statistics 2026: Near Me, Mobile and Purchase Data* — https://biziq.com/blog/local-search-statistics/

**Accessibility market (added research, directional)**
- National Restaurant News, *Why restaurant accessibility is a win for customers of all abilities* — https://www.nrn.com/restaurant-operations/why-restaurant-accessibility-is-a-win-for-customers-of-all-abilities
- GoFoodservice, *Restaurant Accessibility for Visually Impaired Guests* — https://www.gofoodservice.com/blog/is-your-restaurant-accessible-for-the-visually-impaired
- Braille Works, *Make a Meaningful Difference at Your Restaurant* — https://brailleworks.com/meaningful-difference-24hrs/

**Foundational economics**
- Michael Luca, Harvard Business School, *Reviews, Reputation, and Revenue: The Case of Yelp.com*
