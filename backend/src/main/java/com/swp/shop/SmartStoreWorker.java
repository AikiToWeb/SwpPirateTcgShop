package com.swp.shop;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class SmartStoreWorker {
    private final SmartStoreService service;
    public SmartStoreWorker(SmartStoreService service){this.service=service;}
    @Scheduled(initialDelay=60000,fixedDelay=60000)
    public void poll(){
        try{service.scheduledSync();}
        catch(RuntimeException ignored){/* Per-product states are persisted; never log upstream bodies or credentials. */}
    }
}
