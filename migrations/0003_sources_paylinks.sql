-- Where each order came from (Google, Etsy, a campaign...) and an optional payment link per invoice.
ALTER TABLE orders ADD COLUMN source TEXT;
ALTER TABLE invoices ADD COLUMN pay_url TEXT;
