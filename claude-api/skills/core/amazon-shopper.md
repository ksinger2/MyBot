---
name: amazon-shopper
description: Search Amazon for products, compare prices, and manage cart with safety confirmations
triggers:
  - /amazon
  - find on amazon
  - search amazon
  - buy on amazon
  - amazon cart
  - order from amazon
  - track my amazon
requires:
  - browse_url
  - type_input
  - press_key
  - click
  - extract_elements
  - wait_for_element
  - wait_for_text
  - save_session
  - restore_session
  - ask_user
---

# Amazon Shopper Skill

## Overview
Search for products on Amazon, compare options, add items to cart, and assist with purchases. Always requires user confirmation before any purchase actions.

## SAFETY RULES - CRITICAL

1. **NEVER complete a purchase without explicit user confirmation**
2. **Always show price and product details before adding to cart**
3. **Ask for confirmation before proceeding to checkout**
4. **Do not store payment information**
5. **Warn user before any action that spends money**

## Session Management

### First-time setup
User needs to log in manually once:
```
1. browse_url('https://www.amazon.com')
2. Ask user: "Please log into your Amazon account. Tell me when you're done."
3. save_session('amazon')
```

### Subsequent uses
```
1. restore_session('amazon')
2. browse_url('https://www.amazon.com')
3. Verify logged in by checking for account name
```

## Workflows

### 1. Product Search

```
1. restore_session('amazon')  // If session exists
2. browse_url('https://www.amazon.com')
3. type_input('#twotabsearchtextbox', '[product query]')
4. press_key('Enter')
5. wait_for_element('.s-result-item, [data-component-type="s-search-result"]')
6. extract_elements('[data-component-type="s-search-result"]', ['innerText', 'data-asin'])
```

**Selectors**:
- Search box: `#twotabsearchtextbox`, `#nav-search-bar-form input`
- Search results: `.s-result-item`, `[data-component-type="s-search-result"]`
- Product title: `.a-text-normal`, `h2 a span`
- Price: `.a-price .a-offscreen`, `.a-price-whole`
- Rating: `.a-icon-star-small`, `.a-icon-alt`
- Prime badge: `.s-prime`, `[aria-label*="Prime"]`

### 2. Apply Filters

**Price filter**:
```
1. browse_url('https://www.amazon.com/s?k=[query]&rh=p_36:[min]00-[max]00')
   OR use filter UI:
2. click('span[data-action="a-expander-toggle"]')  // Expand Price
3. type_input('#low-price', '[min]')
4. type_input('#high-price', '[max]')
5. click('.a-button-input[type="submit"]')
```

**Sort by**:
- Best Sellers: Add `&s=exact-aware-popularity-rank`
- Price Low to High: Add `&s=price-asc-rank`
- Customer Reviews: Add `&s=review-rank`
- Newest: Add `&s=date-desc-rank`

### 3. Get Product Details

```
1. click('[data-asin="ASIN"] h2 a')  // Click product title
2. wait_for_element('#productTitle')
3. Extract:
   - Title: get_element_text('#productTitle')
   - Price: get_element_text('.a-price .a-offscreen')
   - Rating: get_element_text('#acrCustomerReviewText')
   - Availability: get_element_text('#availability span')
```

### 4. Add to Cart (WITH CONFIRMATION)

```
1. Get product details first
2. ask_user with context:
   "Add [Product Name] ($XX.XX) to your cart?"

3. If confirmed:
   click('#add-to-cart-button')
   wait_for_text('Added to Cart')

4. Report success:
   "Added to cart. Cart total is now $XX.XX"
```

### 5. View Cart

```
1. browse_url('https://www.amazon.com/gp/cart/view.html')
   OR click('#nav-cart')
2. wait_for_element('.sc-list-item')
3. extract_elements('.sc-list-item', ['innerText'])
```

**Extract per item**:
- Product name
- Price
- Quantity
- Subtotal

### 6. Proceed to Checkout (WITH CONFIRMATION)

```
1. Show cart summary:
   "Your cart has X items totaling $XX.XX:
   - [Item 1] - $XX.XX
   - [Item 2] - $XX.XX

   Proceed to checkout?"

2. ask_user for explicit confirmation

3. If confirmed:
   click('input[name="proceedToRetailCheckout"]')

4. STOP and report:
   "Checkout page loaded. Please review and complete your purchase manually.
   I won't enter payment information or place orders automatically."
```

### 7. Track Orders

```
1. restore_session('amazon')
2. browse_url('https://www.amazon.com/gp/your-account/order-history')
3. wait_for_element('.order-card, .order')
4. extract_elements('.order-card', ['innerText'])
```

**Extract**:
- Order date
- Order number
- Items
- Status (shipped, delivered, etc.)
- Tracking info if available

## Output Formats

### Search Results
```markdown
## Amazon Search: "[query]"

| # | Product | Price | Rating | Prime |
|---|---------|-------|--------|-------|
| 1 | [Product Name] | $XX.XX | 4.5★ (1,234) | ✓ |
| 2 | [Product Name] | $XX.XX | 4.2★ (567) | ✓ |
| 3 | [Product Name] | $XX.XX | 4.8★ (89) | - |

**Filters applied**: Under $50, Prime eligible

Which item would you like more details on, or should I add one to your cart?
```

### Product Details
```markdown
## [Product Name]

**Price**: $XX.XX (Was $XX.XX, Save XX%)
**Rating**: 4.5/5 stars (1,234 reviews)
**Availability**: In Stock
**Delivery**: Free Prime delivery by [date]

### Key Features:
- Feature 1
- Feature 2
- Feature 3

Would you like me to add this to your cart?
```

### Cart Summary
```markdown
## Your Amazon Cart

| Item | Price | Qty |
|------|-------|-----|
| [Product 1] | $XX.XX | 1 |
| [Product 2] | $XX.XX | 2 |

**Subtotal**: $XX.XX
**Shipping**: FREE (Prime)
**Estimated Total**: $XX.XX

Ready to checkout?
```

## Error Handling

### Not logged in
```
"You're not logged into Amazon. Would you like to log in now?
I'll open Amazon's login page and you can sign in manually.
Once done, I'll save the session for future use."
```

### Product unavailable
```
"This product is currently unavailable. Would you like me to:
1. Find similar products
2. Check other sellers
3. Set up availability alert (manual)"
```

### Price changed
```
"Note: The price has changed since we last looked.
Previous: $XX.XX
Current: $YY.YY

Still want to proceed?"
```

## Example Queries

- "Find AirPods Pro on Amazon" → Search and show results
- "Add the first one to my cart" → Confirm then add
- "Find wireless keyboards under $50" → Search with price filter
- "What's in my Amazon cart?" → Show cart contents
- "Track my Amazon orders" → Show recent order status
- "Buy this item" → Show details, confirm, then add to cart (NOT auto-purchase)
