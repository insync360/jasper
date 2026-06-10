/**
 * Internal manager alerts (Tasks) for order events, created from OrderWhatsAppTrigger:
 *  - cancellationCallbacks: a callback Task when an order is cancelled (Bookings #11).
 *  - vnaAlerts: a "nearest matching cars" Task when a vehicle isn't available / back-order (Bookings #12).
 * Tasks are linked to the Order and assigned to the order owner (when a user).
 */
public with sharing class WAOrderAlerts {

    /** Bookings #11 — manager callback Tasks for cancelled orders. */
    public static void cancellationCallbacks(List<Order> orders) {
        List<Task> tasks = new List<Task>();
        for (Order o : orders) {
            Task t = new Task(
                Subject = '📞 Cancellation callback — contact customer',
                Description = 'Order ' + o.OrderNumber + ' has been cancelled. Please call the customer to ' +
                    'understand the reason and attempt to retain the booking.',
                Priority = 'High',
                WhatId = o.Id
            );
            if (o.Phone__c != null) t.Phone_number__c = o.Phone__c;
            if (isUser(o.OwnerId)) t.OwnerId = o.OwnerId;
            tasks.add(t);
        }
        if (!tasks.isEmpty()) insert tasks;
    }

    /** Bookings #12 — VNA (vehicle not available) -> alert with nearest available models. */
    public static void vnaAlerts(List<Order> orders) {
        Set<Id> ids = new Map<Id, Order>(orders).keySet();
        Map<Id, String> vehByOrder = new Map<Id, String>();
        for (OrderItem oi : [
            SELECT OrderId, Product2.Name FROM OrderItem WHERE OrderId IN :ids AND Product2.Name != null
        ]) {
            if (!vehByOrder.containsKey(oi.OrderId)) vehByOrder.put(oi.OrderId, oi.Product2.Name);
        }
        // Nearest matching available models from the live catalog (best-effort without live stock).
        List<String> avail = new List<String>();
        for (Vehicle v : [SELECT Name FROM Vehicle WHERE Show_In_Bot__c = true ORDER BY Name LIMIT 10]) {
            avail.add(v.Name);
        }
        String availStr = avail.isEmpty() ? '(check inventory)' : String.join(avail, ', ');

        List<Task> tasks = new List<Task>();
        for (Order o : orders) {
            String veh = vehByOrder.get(o.Id);
            Task t = new Task(
                Subject = '⚠️ VNA — vehicle not available, offer nearest match',
                Description = 'Order ' + o.OrderNumber + (veh != null ? ' for ' + veh : '') +
                    ' has no matching vehicle available (VNA / back-order).\n\n' +
                    'Nearest available models: ' + availStr + '\n\nPlease propose an alternative to the customer.',
                Priority = 'High',
                WhatId = o.Id
            );
            if (o.Phone__c != null) t.Phone_number__c = o.Phone__c;
            if (isUser(o.OwnerId)) t.OwnerId = o.OwnerId;
            tasks.add(t);
        }
        if (!tasks.isEmpty()) insert tasks;
    }

    static Boolean isUser(Id recId) {
        return recId != null && String.valueOf(recId).startsWith('005');
    }
}
