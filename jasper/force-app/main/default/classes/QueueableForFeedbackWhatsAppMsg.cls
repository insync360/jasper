/**
 * @description       : 
 * @author            : ChangeMeIn@UserSettingsUnder.SFDoc
 * @group             : 
 * @last modified on  : 05-29-2025
 * @last modified by  : ChangeMeIn@UserSettingsUnder.SFDoc
**/
public class QueueableForFeedbackWhatsAppMsg implements Queueable, Database.AllowsCallouts {
    private List<Id> leadIds;
    private String templateName;
    private String imageUrl;
    private Map<Id, String> leadIdByPhoneMap;
    private Map<Id, String> leadIdByUrlMap;
    
    public QueueableForFeedbackWhatsAppMsg(List<Id> leadIds, String templateName, String imageUrl, Map<Id, String> leadIdByPhoneMap, Map<Id, String> leadIdByUrlMap) {
        this.leadIds = new List<Id>(leadIds);
        this.templateName = templateName;
        this.imageUrl = imageUrl;
        this.leadIdByPhoneMap = leadIdByPhoneMap;
        this.leadIdByUrlMap = leadIdByUrlMap;
    }
    
    public void execute(QueueableContext qc) {
        if (!leadIds.isEmpty()) {
            Id currentLeadId = leadIds.remove(0);
            String phoneNumber = leadIdByPhoneMap.get(currentLeadId);
            String feedbackUrl = leadIdByUrlMap.get(currentLeadId);
            
            System.debug('currentLeadId ==> ' + currentLeadId);
            System.debug('phoneNumber ==> ' + phoneNumber);
            System.debug('feedbackUrl ==> ' + feedbackUrl);
            
            if (phoneNumber != null && currentLeadId != null) {
                imageTemplateMsg(phoneNumber, templateName, imageUrl, feedbackUrl,currentLeadId);
            }
            
            if (!leadIds.isEmpty() && !Test.isRunningTest()) {
                System.enqueueJob(new QueueableForFeedbackWhatsAppMsg(leadIds, templateName, imageUrl, leadIdByPhoneMap, leadIdByUrlMap));
            }
        }
    }
    
    public static void imageTemplateMsg(String phoneNumber, String templateName, String imageUrl, String feedbackUrl,String currentLeadId) {
        WhatsappIntegration__c w = WhatsappIntegration__c.getInstance('WhatsApp API');
        String url = String.isNotBlank(w.API_Endpoint__c) ? w.API_Endpoint__c : '';
        String apikey = String.isNotBlank(w.API_Key__c) ? w.API_Key__c : '';
        String recipientPhoneNumber = '91' + phoneNumber;
        
        System.debug('currentLeadId==>'+currentLeadId);
        
        if (String.isNotBlank(recipientPhoneNumber) && String.isNotBlank(templateName) &&
            String.isNotBlank(imageUrl) && String.isNotBlank(url) && String.isNotBlank(apikey)) {
                
                Http http = new Http();
                HttpRequest request = new HttpRequest();
                request.setEndpoint(url);
                request.setMethod('POST');
                request.setTimeout(20000);
                request.setHeader('apikey', apikey);
                request.setHeader('Content-Type', 'application/json');
                
                // Ensure feedbackUrl is not null
                if (feedbackUrl == null) {
                    System.debug('feedbackUrl is null');
                    feedbackUrl = '';
                }
                String safeFeedbackUrl = String.valueOf(feedbackUrl);
                System.debug('feedbackUrl value: ' + safeFeedbackUrl);
                
                //Map<String, Object> payload = new Map<String, Object>();
                // payload.put('recipient', new Map<String, Object>{ 'id' => recipientPhoneNumber });
                
                // payload.put('template', new Map<String, Object>{
                //     'name' => templateName,
                //         'language' => 'en_US',
                //         'components' => new List<Object>{
                //             new Map<String, Object>{
                //                 'type' => 'header',
                //                     'parameters' => new List<Object>{
                //                         new Map<String, Object>{
                //                             'type' => 'image',
                //                                 'image' => new Map<String, Object>{ 'link' => imageUrl }
                //                         }
                //                     }
                //             },
                //                 new Map<String, Object>{
                //                     'type' => 'body',
                //                         'parameters' => new List<Object>{
                //                             new Map<String, Object>{
                //                                 'type' => 'text',
                //                                     'text' => safeFeedbackUrl
                //                                     }
                //                         }
                //                 }
                //         }
                // });
                
                // payload.put('type', 'template');
                // payload.put('kookoo_id', 'OZNTLWA:918197205802');

                                    Map<String, Object> payload = new Map<String, Object>();
                    
                    
                    Map<String, Object> recipient = new Map<String, Object>();
                    recipient.put('id', String.valueOf(recipientPhoneNumber));
                    
                    Map<String, Object> template = new Map<String, Object>();
                    template.put('name', String.valueOf(templateName));
                    template.put('language', 'en_US');
                    
                    
                    template.put('parameters', new List<Object>());
                    
                    
                    List<Map<String, Object>> buttonParametersList = new List<Map<String, Object>>();
                    
                    
                    Map<String, Object> buttonParamText = new Map<String, Object>();
                    buttonParamText.put('type', 'text');
                    buttonParamText.put('text',currentLeadId);
                    
                    
                    Map<String, Object> button = new Map<String, Object>();
                    button.put('type', 'button');
                    button.put('index', '0');
                    button.put('sub_type', 'url');
                    button.put('parameters', new List<Object>{ buttonParamText });
                    
                    
                    buttonParametersList.add(button);
                    
                    
                    template.put('buttonParameters', buttonParametersList);
                    
                    
                    payload.put('recipient', recipient);
                    payload.put('kookoo_id', 'OZNTLWA:918197205802');
                    payload.put('type', 'template');
                    payload.put('template', template);


                
                String reqBody = JSON.serialize(payload);
                System.debug('Request Payload ==> ' + JSON.serializePretty(payload));
                request.setBody(reqBody);
                
                Boolean isSuccess = false;
                Integer retryCount = 0;
                String status = 'Failed';
                String responseBody = '';
                String statusCode = '';
                
                while (!isSuccess && retryCount < 3) {
                    try {
                        HttpResponse response = http.send(request);
                        responseBody = response.getBody();
                        statusCode = String.valueOf(response.getStatusCode());
                        
                        if (response.getStatusCode() == 200) {
                            isSuccess = true;
                            status = 'Success';
                        } else {
                            retryCount++;
                            System.debug('Retrying... attempt: ' + retryCount);
                        }
                    } catch (Exception e) {
                        retryCount++;
                        System.debug('Retry due to exception: ' + e.getMessage());
                    }
                }
                
                try {
                    /*IntegrationLogHelper.IntegrationLogWrapper wrapper = new IntegrationLogHelper.IntegrationLogWrapper();
                    wrapper.requestBody = reqBody;
                    wrapper.responseBody = responseBody;
                    wrapper.status = status;
                    wrapper.templateName = templateName;
                    wrapper.statusCode = statusCode;
                    IntegrationLogHelper.createIntegrationLogs(wrapper);*/
                    System.debug('Integration log recorded successfully');
                } catch (Exception logEx) {
                    System.debug('Log recording failed: ' + logEx.getMessage());
                }
            }
    }
    
    
}