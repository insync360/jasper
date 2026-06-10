/**
 * Bookings #6 — AI/automated urgency to complete retail within 5 days of allocation.
 * Daily job: finds orders allocated 3 or 5 days ago that aren't yet delivered/cancelled and
 * sends an urgency nudge to the customer (jasper_retail_urgency). On day 5 it also creates a
 * manager escalation Task. Schedule with:
 *   System.schedule('WA Retail Urgency', '0 0 10 * * ?', new WARetailUrgencyScheduler());
 */
public with sharing class WARetailUrgencyScheduler implements Schedulable {

    static final Set<String> DONE = new Set<String>{
        'Vehicle Delivered', 'Delivered', 'Order Cancelled', 'Cancellation Requested'
    };

    public void execute(SchedulableContext sc) {
        Date d3 = Date.today().addDays(-3);
        Date d5 = Date.today().addDays(-5);
        List<Date> days = new List<Date>{ d3, d5 };
        List<Order> orders = [
            SELECT Id, OrderNumber, Phone__c, Status, Allocation_Date__c, OwnerId, Account.Name,
                   (SELECT Product2.Name FROM OrderItems LIMIT 1)
            FROM Order
            WHERE Allocation_Date__c != null AND Phone__c != null
              AND Allocation_Date__c IN :days AND Status NOT IN :DONE
        ];
        if (!orders.isEmpty()) System.enqueueJob(new Sender(orders, d5));
    }

    public class Sender implements Queueable, Database.AllowsCallouts {
        List<Order> orders;
        Date d5;
        public Sender(List<Order> o, Date day5) {
            this.orders = o;
            this.d5 = day5;
        }
        public void execute(QueueableContext qc) {
            WA_Bot_Setting__c s = WA_Bot_Setting__c.getOrgDefaults();
            String base = (s == null || s.Base_URL__c == null) ? '' : s.Base_URL__c.removeEnd('/');
            List<Task> escalations = new List<Task>();
            for (Order o : orders) {
                String vehicle = '';
                if (o.OrderItems != null && !o.OrderItems.isEmpty() && o.OrderItems[0].Product2 != null) {
                    vehicle = o.OrderItems[0].Product2.Name;
                }
                Map<String, String> data = new Map<String, String>{
                    'name' => (o.Account != null && o.Account.Name != null) ? o.Account.Name : 'Customer',
                    'vehicle' => vehicle,
                    'orderNumber' => o.OrderNumber
                };
                sendNudge(base, normalize(o.Phone__c), data);

                if (o.Allocation_Date__c == d5) {
                    Task t = new Task(
                        Subject = '⏳ Retail not completed in 5 days — please expedite',
                        Description = 'Order ' + o.OrderNumber + ' was allocated on ' + o.Allocation_Date__c.format() +
                            ' but retail is still not completed. Please follow up to close it.',
                        Priority = 'High',
                        WhatId = o.Id
                    );
                    if (o.Phone__c != null) t.Phone_number__c = o.Phone__c;
                    if (String.valueOf(o.OwnerId).startsWith('005')) t.OwnerId = o.OwnerId;
                    escalations.add(t);
                }
            }
            if (!escalations.isEmpty()) insert escalations;
        }

        void sendNudge(String base, String phone, Map<String, String> data) {
            if (String.isBlank(phone)) return;
            Map<String, Object> body = new Map<String, Object>{
                'to' => phone, 'template' => 'jasper_retail_urgency', 'language' => 'en',
                'components' => new List<Object>{
                    new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams('jasper_retail_urgency', data, true) }
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
                System.debug('retail urgency send failed: ' + e.getMessage());
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
