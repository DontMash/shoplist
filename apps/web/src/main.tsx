import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import { Router } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import './app.css';
import { App } from './app';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

registerSW({ immediate: true });

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing');

console.info(`                                       
 
  @@@@@                            
 @@@@@@@                           
 @@@@@@@@@@@@@@@                   
    @@@@@@@@@@@@@@@@@@@@@@@@@@     
    @@@@@@@@@@@@@@@@@@@@@@@@@@     
    @@@@                  @@@@     
    @@@@                  @@@@     
    @@@@                  @@@@     
    @@@@                 @@@@      
    @@@@@@@@@@@@@@@@@@@@@@@@@      
    @@@@@@@@@@@@@@@@@@@@@@@@@      
    @@@@@@@@@@@@@@@@@@@@@@@@       
    @@@@                           
  @@@@@@@@@@@@@@@@@@@@@@@@@        
 @@@@@@@@@@@@@@@@@@@@@@@@@@@@      
 @@@@  @@@@       @@@@@  @@@@      
 @@@@@@@@@@        @@@@@@@@@@      
  @@@@@@@@         @@@@@@@@@       
    @@@               @@@          
                                       
           Shoplist

made with ♥  by https://www.soren.codes
`);

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <Router hook={useHashLocation}>
      <App />
    </Router>
  </QueryClientProvider>,
);
