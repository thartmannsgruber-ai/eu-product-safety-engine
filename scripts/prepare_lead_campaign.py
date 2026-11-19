#!/usr/bin/env python3
"""
Crawls lead websites, analyzes categories, and generates customized native-language
outreach email drafts for all 56 leads.
"""

import json
import os
import re
import ssl
import urllib.request
import urllib.error
from html import unescape
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEADS_FILE = os.path.join(BASE_DIR, '.market', 'leads', 'leads.json')
DRAFTS_DIR = os.path.join(BASE_DIR, '.market', 'leads', 'drafts')
CAMPAIGN_FILE = os.path.join(BASE_DIR, '.market', 'leads', 'outreach_campaign.json')

os.makedirs(DRAFTS_DIR, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

def crawl_site(url):
    if not url or not url.startswith('http'):
        return None, None
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=4) as resp:
            content = resp.read().decode('utf-8', errors='ignore')
            
            # Title
            title_m = re.search(r'<title[^>]*>(.*?)</title>', content, re.I | re.S)
            title = unescape(re.sub(r'\s+', ' ', title_m.group(1)).strip()) if title_m else ''
            
            # Meta description
            desc_m = re.search(r'<meta[^>]+(?:name|property)=[\'"](?:description|og:description)[\'"][^>]+content=[\'"](.*?)[\'"]', content, re.I | re.S)
            if not desc_m:
                desc_m = re.search(r'<meta[^>]+content=[\'"](.*?)[\'"][^>]+(?:name|property)=[\'"](?:description|og:description)[\'"]', content, re.I | re.S)
            desc = unescape(re.sub(r'\s+', ' ', desc_m.group(1)).strip()) if desc_m else ''
            
            return title[:120], desc[:250]
    except Exception as e:
        return None, None

def analyze_profile(company, category, title, desc, country):
    text = f"{company} {category} {title or ''} {desc or ''}".lower()
    
    # Specific category detection
    if any(k in text for k in ['modellismo', 'modelbouw', 'rc', 'drones', 'miniatures', 'ferngesteuert']):
        hook_category = {
            'nl': 'modelbouw-, RC- en miniatuurartikelen',
            'fr': 'articles de modélisme, radiocommandés et miniatures',
            'it': 'articoli di modellismo, radiocomandati e miniature',
            'es': 'artículos de modelismo, radiocontrol y miniaturas',
            'de': 'Modellbau-, RC- und Miniaturartikel',
            'en': 'scale models, RC and electronic miniature toys'
        }
        rapex_count = "28"
    elif any(k in text for k in ['hout', 'bois', 'legno', 'madera', 'holz', 'wooden']):
        hook_category = {
            'nl': 'houten speelgoed en educatieve artikelen',
            'fr': 'jouets en bois et articles éducatifs',
            'it': 'giocattoli in legno e articoli educativi',
            'es': 'juguetes de madera y artículos educativos',
            'de': 'Holzspielwaren und pädagogische Lernartikel',
            'en': 'wooden toys and educational play articles'
        }
        rapex_count = "19"
    elif any(k in text for k in ['bébé', 'baby', 'neonati', 'puericultura', 'infant', 'childcare', 'kleinkind']):
        hook_category = {
            'nl': 'baby- en peuterartikelen en eerste-leeftijd speelgoed',
            'fr': 'articles de puériculture et jouets premier âge',
            'it': 'articoli per la prima infanzia e giocattoli prima infanzia',
            'es': 'artículos de puericultura y juguetes primera infancia',
            'de': 'Baby-, Kleinkind- und Erstausstattungsspielwaren',
            'en': 'infant, baby products and early childhood toys'
        }
        rapex_count = "24"
    elif any(k in text for k in ['fêtes', 'feest', 'party', 'kermesse', 'festartikel', 'carnevale', 'costumes', 'disfraces']):
        hook_category = {
            'nl': 'feest-, kermis- en themaspeelgoed',
            'fr': 'articles de fête, kermesse et déguisements',
            'it': 'articoli per feste, carnevale e giocattoli da regalo',
            'es': 'artículos de fiesta, disfraces y juguetes para eventos',
            'de': 'Party-, Karneval- und Geschenkartikel',
            'en': 'party novelties, costumes and festival toy items'
        }
        rapex_count = "17"
    else:
        hook_category = {
            'nl': 'groothandelsassortiment speelgoed, pluche en vrijetijdsartikelen',
            'fr': 'assortiment de jouets, peluches et jeux récréatifs',
            'it': 'assortimento di giocattoli, peluche e giochi ricreativi',
            'es': 'gama de juguetes, peluches y juegos recreativos',
            'de': 'Großhandels-Sortiment an Spielwaren, Plüsch und Freizeitartikeln',
            'en': 'wholesale toy range, plush and recreational play items'
        }
        rapex_count = "34"
        
    return hook_category, rapex_count

def generate_draft(lead, title, desc):
    country = lead['country']
    company = lead['company']
    email = lead['email']
    actor_url = "https://apify.com/thfc_labs/eu-product-safety-actor"
    
    # Language mapping
    lang_map = {
        'Netherlands': 'nl',
        'France': 'fr',
        'Italy': 'it',
        'Spain': 'es',
        'Austria': 'de',
        'Poland': 'en'
    }
    lang = lang_map.get(country, 'en')
    
    if lang == 'de':
        subject = f"Safety-Gate-Abgleich für {company}?"
        body = f"""Sehr geehrte Damen und Herren,

ich bin Thomas Hartmannsgruber von THFC Consulting und entwickle zielgerichtete Software-Engines für Unternehmen. Hintergrundinformationen zu mir und unseren entwickelten Engines können Sie direkt auf meiner Labs-Seite einsehen:
https://thfc-consulting.de/labs/product-safety

Für Ihren Produkt-Kontext habe ich ein interessantes Werkzeug gebaut, das EANs und Produktnamen automatisch gegen das EU Safety Gate abgleicht, denn wie Sie vielleicht wissen, gilt seit Dezember 2024 die neue EU-Produktsicherheitsverordnung (GPSR). Da das EU Safety Gate jede Woche neue Meldungen veröffentlicht und Spielzeug dort regelmäßig zu den häufigsten Kategorien gehört, ist es aus Compliance-Gesichtspunkten essenziell, auf dem aktuellen Stand zu bleiben.

Um die Engine kennenzulernen, würde ich Ihnen anbieten, 50 Artikel aus Ihrem Sortiment unverbindlich und zunächst kostenlos zu prüfen. Eine kurze Antwort genügt.

Wenn Sie mit dem Ergebnis zufrieden sind, würde ich Sie auf meine entwickelte Engine via der international renommierten SaaS-Plattform Apify verweisen:
{actor_url}

Viele Grüße
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden

Kein Interesse? Antworten Sie einfach kurz mit „Nein“ – dann melde ich mich nicht wieder.
"""
    elif lang == 'fr':
        subject = f"Vérification Safety Gate pour {company} ?"
        body = f"""Madame, Monsieur,

Je suis Thomas Hartmannsgruber de THFC Consulting et je développe des moteurs logiciels dédiés aux entreprises. Vous trouverez des informations détaillées sur mon parcours et sur nos moteurs technologiques directement sur notre page Labs :
https://thfc-consulting.de/labs/product-safety-en

Pour votre catalogue de produits, j'ai conçu un outil qui vérifie automatiquement les codes EAN et noms de produits par rapport à la base officielle EU Safety Gate. Comme vous le savez sans doute, le règlement européen sur la sécurité générale des produits (GPSR) est en vigueur depuis décembre 2024. Le système EU Safety Gate publiant de nouvelles alertes chaque semaine et les jouets figurant régulièrement parmi les catégories les plus signalées, il est essentiel pour votre conformité de rester à jour.

Afin de découvrir cet outil, je vous propose de vérifier 50 articles de votre catalogue de manière sans engagement et gratuite. Une simple réponse à cet e-mail suffit.

Si le résultat vous convient, vous pourrez ensuite utiliser ce moteur en toute autonomie via la plateforme SaaS reconnue Apify :
{actor_url}

Cordialement,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Allemagne

Pas intéressé ? Répondez simplement « Non » et je ne vous recontacterai pas.
"""
    elif lang == 'nl':
        subject = f"Safety Gate controle voor {company}?"
        body = f"""Geachte heer, mevrouw,

Mijn naam is Thomas Hartmannsgruber van THFC Consulting en ik ontwikkel gerichte software-engines voor bedrijven. Achtergrondinformatie over mij en onze ontwikkelde engines vindt u direct op onze Labs-pagina:
https://thfc-consulting.de/labs/product-safety-en

Voor uw productassortiment heb ik een tool gebouwd die EAN-codes en productnamen automatisch controleert tegen de officiële EU Safety Gate database. Zoals u wellicht weet, geldt sinds december 2024 de nieuwe Europese Verordening Algemene Productveiligheid (GPSR). Aangezien het EU Safety Gate wekelijks nieuwe meldingen publiceert en speelgoed regelmatig tot de meest gemelde categorieën behoort, is het vanuit compliance-oogpunt essentieel om actueel te blijven.

Om vrijblijvend kennis te maken met de engine, bied ik u aan om eerst 50 artikelen uit uw assortiment kosteloos te controleren. Een kort antwoord op deze mail is voldoende.

Indien u tevreden bent over het resultaat, kunt u de engine desgewenst flexibel inzetten via het internationaal gerenommeerde SaaS-platform Apify:
{actor_url}

Met vriendelijke groet,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Duitsland

Geen interesse? Reageer kort met "Nee" en ik neem geen contact meer met u op.
"""
    elif lang == 'it':
        subject = f"Verifica Safety Gate per {company}?"
        body = f"""Gentili signori,

sono Thomas Hartmannsgruber di THFC Consulting e sviluppo motori software mirati per le aziende. Potete consultare informazioni di approfondimento su di me e sui nostri motori tecnologici direttamente sulla nostra pagina Labs:
https://thfc-consulting.de/labs/product-safety-en

Per il vostro catalogo prodotti ho realizzato uno strumento che confronta automaticamente codici EAN e denominazioni prodotto con il database ufficiale EU Safety Gate. Come forse saprete, da dicembre 2024 è in vigore il nuovo regolamento europeo sulla sicurezza generale dei prodotti (GPSR). Poiché l'EU Safety Gate pubblica nuove segnalazioni ogni settimana e i giocattoli rientrano regolarmente tra le categorie più interessate, è essenziale sotto il profilo della conformità rimanere sempre aggiornati.

Per farvi conoscere il funzionamento del motore, vi propongo di verificare 50 articoli del vostro assortimento senza alcun impegno e gratuitamente. È sufficiente una breve risposta a questa e-mail.

Se sarete soddisfatti del risultato, potrete in seguito utilizzare il motore in totale autonomia tramite la rinomata piattaforma SaaS internazionale Apify:
{actor_url}

Cordiali saluti,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Germania

Non siete interessati? Rispondete semplicemente "No" e non vi ricontatterò più.
"""
    elif lang == 'es':
        subject = f"Verificación Safety Gate para {company}?"
        body = f"""Estimados señores:

Soy Thomas Hartmannsgruber, de THFC Consulting, y desarrollo motores de software orientados a empresas. Puede consultar información detallada sobre mi trayectoria y sobre nuestros motores tecnológicos directamente en nuestra página Labs:
https://thfc-consulting.de/labs/product-safety-en

Para su catálogo de productos he diseñado una herramienta que coteja automáticamente códigos EAN y nombres de productos con el sistema oficial EU Safety Gate. Como sabrán, desde diciembre de 2024 se aplica el nuevo Reglamento General de Seguridad de los Productos de la UE (GPSR). Dado que el EU Safety Gate publica nuevas alertas cada semana y los juguetes se encuentran habitualmente entre las categorías con mayor número de avisos, resulta esencial desde el punto de vista del cumplimiento normativo mantenerse al día.

Para que conozcan la herramienta, les ofrezco revisar 50 artículos de su catálogo de forma gratuita y sin compromiso. Basta con responder brevemente a este correo.

Si quedan satisfechos con el resultado, podrán utilizar el motor cuando lo deseen a través de la reconocida plataforma internacional SaaS Apify:
{actor_url}

Un cordial saludo,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Alemania

¿No le interesa? Responda simplemente «No» y no volveré a escribirle.
"""
    else: # English for Poland & international
        subject = f"Safety Gate compliance check for {company}?"
        body = f"""Dear Sir or Madam,

My name is Thomas Hartmannsgruber from THFC Consulting. I develop specialized software engines for businesses. You can find detailed background information about me and our technology engines directly on our Labs page:
https://thfc-consulting.de/labs/product-safety-en

For your product context, I have built a tool that automatically cross-checks EAN barcodes and product titles against the official EU Safety Gate database. As you may know, the new EU General Product Safety Regulation (GPSR) has been in force since December 2024. Because the EU Safety Gate publishes new recall alerts every week, and toys consistently represent one of the most frequently flagged categories, staying continuously compliant is essential.

To introduce you to the engine, I would be glad to check 50 items from your product range free of charge and without any obligation. A brief reply to this email is all it takes.

If you are satisfied with the results, you can continue using the engine flexibly via the internationally renowned SaaS platform Apify:
{actor_url}

Best regards,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Germany

Not interested? Simply reply "No" and I will not contact you again.
"""

    return {
        'company': company,
        'country': country,
        'city': lead.get('city', ''),
        'language': lang,
        'email': email,
        'website': lead.get('website', ''),
        'phone': lead.get('phone', ''),
        'crawled_title': title or '',
        'crawled_desc': desc or '',
        'detected_focus': lead.get('category', 'Toys'),
        'subject': subject,
        'body': body
    }

def main():
    print("Loading leads...")
    with open(LEADS_FILE, 'r', encoding='utf-8') as f:
        leads = json.load(f)
        
    print(f"Total leads to process: {len(leads)}")
    
    # Concurrent crawl
    urls = [l.get('website') for l in leads]
    crawled_results = {}
    
    print("Crawling lead websites...")
    with ThreadPoolExecutor(max_workers=8) as executor:
        future_to_lead = {executor.submit(crawl_site, l.get('website')): idx for idx, l in enumerate(leads)}
        for future in as_completed(future_to_lead):
            idx = future_to_lead[future]
            title, desc = future.result()
            crawled_results[idx] = (title, desc)
            
    campaign_leads = []
    
    for idx, lead in enumerate(leads):
        title, desc = crawled_results.get(idx, (None, None))
        draft = generate_draft(lead, title, desc)
        campaign_leads.append(draft)
        
        # Save individual draft
        slug = re.sub(r'[^a-zA-Z0-9_-]', '_', lead['company'].lower())[:40]
        draft_filename = f"{idx+1:02d}_{lead['country'].lower()}_{slug}.md"
        draft_path = os.path.join(DRAFTS_DIR, draft_filename)
        
        with open(draft_path, 'w', encoding='utf-8') as f:
            f.write(f"# Lead Outreach: {lead['company']} ({lead['country']})\n\n")
            f.write(f"- **To:** {draft['email']}\n")
            f.write(f"- **Language:** {draft['language'].upper()}\n")
            f.write(f"- **Website:** {draft['website']}\n")
            f.write(f"- **Phone:** {draft['phone']}\n")
            f.write(f"- **Detected Focus:** {draft['detected_focus']}\n\n")
            f.write(f"### Subject:\n`{draft['subject']}`\n\n")
            f.write(f"### Body:\n```text\n{draft['body']}\n```\n")
            
    with open(CAMPAIGN_FILE, 'w', encoding='utf-8') as f:
        json.dump(campaign_leads, f, indent=2, ensure_ascii=False)
        
    print(f"Done! Created {len(campaign_leads)} customized drafts in {DRAFTS_DIR} and {CAMPAIGN_FILE}")

if __name__ == '__main__':
    main()
