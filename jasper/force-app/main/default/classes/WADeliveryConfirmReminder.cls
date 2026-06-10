/**
 * Bookings #7 (auto-chase) — take delivery confirmation automatically from allocated bookings.
 *
 * When an Order becomes "Ready For Delivery" the bot sends jasper_delivery_ready with a
 * "Confirm Delivery" quick-reply button; tapping it stamps Order.Delivery_Confirmed__c.
 * This daily job chases the customers who haven't tapped it yet:
 *   - first time an unconfirmed ready order is seen -> stamp Ready_For_Delivery_On__c (day 0)
 *   - day 2 and day 4  -> re-send the Confirm Delivery button (jasper_delivery_ready)
 *   - day 6            -> raise a High-priority manager Task to confirm manually
 * Once the customer taps (Delivery_Confirmed__c = true) the order drops out of the cycle.
 * Exact-day matching (like WARetailUrgencyScheduler) means each order is reminded/escalated once.
 *
 * Schedule daily (e.g. 11 AM) with:
 *   System.schedule('WA Delivery Confirm Reminder', '0 0 11 * * ?', new WADeliveryConfirmReminder());
 */
public with sharing class WADeliveryConfirmReminder implements Schedulable {

    public void execute(SchedulableContext sc) {
        Date today = Date.today();
        List<Order> orders = [
            SELECT Id, OrderNumber, Phone__c, Status, Ready_For_Delivery_On__c, OwnerId, Account.Name,
                   (SELECT Product2.Name FROM OrderItems LIMIT 1)
            FROM Order
            WHERE Status = 'Ready For Delivery'
              AND Delivery_Confirmed__c = false
              AND Phone__c != null
        ];

        List<Order> toStamp = new List<Order>();
        List<Order> dueReminder = new List<Order>();
        List<Order> dueFallback = new List<Order>();

        for (Order o : orders) {
            if (o.Ready_For_Delivery_On__c == null) {
                // First sight of an unconfirmed ready order: anchor day 0 (no message this run).
                toStamp.add(new Order(Id = o.Id, Ready_For_Delivery_On__c = today));
                continue;
            }
            Integer days = o.Ready_For_Delivery_On__c.daysBetween(today);
            if (days == 2 || days == 4) {
                dueReminder.add(o);
            } else if (days == 6) {
                dueFallback.add(o);
            }
        }

        if (!toStamp.isEmpty()) update toStamp;
        if (!dueReminder.isEmpty() || !dueFallback.isEmpty()) {
            System.enqueueJob(new Sender(dueReminder, dueFallback));
        }
    }

    /** Async callout job: re-sends the button (reminders) and creates manager Tasks (fallback). */
    public class Sender implements Queueable, Database.AllowsCallouts {
        List<Order> reminders;
        List<Order> fallbacks;
        public Sender(List<Order> r, List<Order> f) {
            this.reminders = r;
            this.fallbacks = f;
        }

        public void execute(QueueableContext qc) {
            WA_Bot_Setting__c s = WA_Bot_Setting__c.getOrgDefaults();
            String base = (s == null || s.Base_URL__c == null) ? '' : s.Base_URL__c.removeEnd('/');

            // Day 2 / Day 4 — re-send the jasper_delivery_ready template (carries the Confirm Delivery button).
            for (Order o : reminders) {
                Map<String, String> data = new Map<String, String>{
                    'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : 'Customer',
                    'vehicle' => vehicleOf(o),
                    'orderNumber' => o.OrderNumber
                };
                send(base, normalize(o.Phone__c), data);
            }

            // Day 6 — final fallback: High-priority manager Task to confirm manually.
            List<Task> tasks = new List<Task>();
            for (Order o : fallbacks) {
                Task t = new Task(
                    Subject = '📦 Delivery not confirmed by customer — please confirm',
                    Description = 'Order ' + o.OrderNumber + ' has been Ready For Delivery for 6 days but the ' +
                        'customer has not confirmed delivery on WhatsApp. Please contact the customer to confirm ' +
                        'receipt and update the order.',
                    Priority = 'High',
                    Status = 'Not Started',
                    WhatId = o.Id
                );
                if (o.Phone__c != null) t.Phone_number__c = o.Phone__c;
                if (String.valueOf(o.OwnerId).startsWith('005')) t.OwnerId = o.OwnerId;
                tasks.add(t);
            }
            if (!tasks.isEmpty()) insert tasks;
        }

        String vehicleOf(Order o) {
            if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
                return o.OrderItems[0].Product2.Name;
            }
            return '';
        }

        void send(String base, String phone, Map<String, String> data) {
            if (String.isBlank(phone)) return;
            Map<String, Object> body = new Map<String, Object>{
                'to' => phone, 'template' => 'jasper_delivery_ready', 'language' => 'en',
                'components' => new List<Object>{
                    new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams('jasper_delivery_ready', data, true) }
                }
            };
            try {
                HttpRequest req = new HttpRequest();
                req.setEndpoint(base + '/send/template');
                req.setMethod('POST');
                req.setHeader('Content-Type', 'application/json');
                req.setTimeout(60000);
                req.setBody(JSON.serialize(body));
                new Http().send(req);
            } catch (Exception e) {
                System.debug('delivery confirm reminder send failed: ' + e.getMessage());
            }
        }

        String normalize(String p) {
            if (p == null) return '';
            String d = p.replaceAll('[^0-9]', '');
            if (d.length() == 10) d = '91' + d;
            return d;
        }
    }
}
