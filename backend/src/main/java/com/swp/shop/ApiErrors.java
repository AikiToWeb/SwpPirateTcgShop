package com.swp.shop;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.dao.DataAccessException;

@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(ResponseStatusException.class) ResponseEntity<?> status(ResponseStatusException e){return ResponseEntity.status(e.getStatusCode()).body(Map.of("detail",e.getReason()==null?"요청 실패":e.getReason()));}
    @ExceptionHandler({MethodArgumentNotValidException.class,HttpMessageNotReadableException.class}) ResponseEntity<?> validation(Exception e){return ResponseEntity.unprocessableEntity().body(Map.of("detail","입력값을 확인하세요."));}
    @ExceptionHandler(DataAccessException.class) ResponseEntity<?> database(DataAccessException e){return ResponseEntity.status(409).body(Map.of("detail","데이터가 변경되었습니다. 다시 시도하세요."));}
}
