package com.swp.shop;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

public class InventoryException extends ResponseStatusException {
    final String code;
    public InventoryException(int status,String code,String message){super(HttpStatus.valueOf(status),message);this.code=code;}
    @RestControllerAdvice
    @org.springframework.core.annotation.Order(-1)
    static class Handler {
        @ExceptionHandler(InventoryException.class)
        ResponseEntity<?> handle(InventoryException error){return ResponseEntity.status(error.getStatusCode()).body(Map.of("code",error.code,"detail",error.getReason()));}
    }
}
